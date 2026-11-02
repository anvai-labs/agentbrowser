export interface JsonLedgerOptions {
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
}

export type JsonLedgerScanDecision<T> =
  | { action: 'skip' }
  | { action: 'stop' }
  | { action: 'emit'; value: T };

export interface JsonLedgerWindow {
  oldestSeq: number;
  gap: boolean;
  highWaterMark: number;
}

/** Count- and UTF-8-byte-bounded FIFO. Serialized ownership prevents mutation drift. */
export class JsonLedger<T> {
  private readonly entries = new Map<number, { json: string; bytes: number }>();
  private sequence = 0;
  private bytes = 0;
  private dropped = 0;
  private evicted = 0;

  constructor(private readonly options: JsonLedgerOptions) {
    for (const value of Object.values(options))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error('Ledger limits must be positive safe integers');
  }

  push(value: T): boolean {
    const json = JSON.stringify(value);
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > Math.min(this.options.maxEntryBytes, this.options.maxBytes)) {
      this.dropped++;
      return false;
    }
    while (
      this.entries.size >= this.options.maxEntries ||
      this.bytes + bytes > this.options.maxBytes
    ) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
      this.evicted++;
    }
    this.entries.set(this.sequence++, { json, bytes });
    this.bytes += bytes;
    return true;
  }

  toArray(): T[] {
    return [...this.entries.values()].map(({ json }) => JSON.parse(json) as T);
  }

  /** Paging, oldest first. Up to `limit` (matching) entries with sequence >
   * since. Cursors are entry sequence numbers; eviction removes low sequences,
   * so a cursor below the retained window re-reads from the oldest kept entry.
   * `lastScanned` is the sequence of the last entry examined, matched or not,
   * so the next cursor moves past skipped entries; it is `since` when nothing
   * lies after the cursor. `oldestSeq` is the lowest retained sequence (the
   * next sequence to be written when empty); `gap` is true when entries
   * between the cursor and the retained window were evicted.
   */
  page(
    since: number,
    limit: number,
    predicate?: (value: T) => boolean
  ): {
    rows: { seq: number; value: T }[];
    lastScanned: number;
    oldestSeq: number;
    gap: boolean;
  } {
    if (!Number.isSafeInteger(since) || !Number.isSafeInteger(limit) || limit < 1)
      throw new Error('Invalid ledger paging arguments');
    const oldestSeq = this.entries.keys().next().value ?? this.sequence;
    const rows: { seq: number; value: T }[] = [];
    let lastScanned = since;
    for (const [seq, entry] of this.entries) {
      if (seq <= since) continue;
      lastScanned = seq;
      const value = JSON.parse(entry.json) as T;
      if (predicate && !predicate(value)) continue;
      rows.push({ seq, value });
      if (rows.length >= limit) break;
    }
    return { rows, lastScanned, oldestSeq, gap: since < oldestSeq - 1 };
  }

  /** Snapshot one retained window; stop keeps the current row eligible next time. */
  scanPage<R>(
    since: number,
    limit: number,
    inspect: (
      value: T,
      seq: number,
      window: Readonly<JsonLedgerWindow>
    ) => JsonLedgerScanDecision<R>
  ): {
    rows: { seq: number; value: R }[];
    lastScanned: number;
    oldestSeq: number;
    gap: boolean;
  } {
    if (!Number.isSafeInteger(since) || since < -1 || !Number.isSafeInteger(limit) || limit < 1)
      throw new Error('Invalid ledger paging arguments');
    // Capture before callbacks: reentrant producers cannot extend this scan.
    const retained = [...this.entries];
    const oldestSeq = retained[0]?.[0] ?? this.sequence;
    const window = Object.freeze({
      oldestSeq,
      gap: since < oldestSeq - 1,
      highWaterMark: retained.at(-1)?.[0] ?? this.sequence - 1,
    });
    const rows: { seq: number; value: R }[] = [];
    let lastScanned = since;
    for (const [seq, entry] of retained) {
      if (seq <= since) continue;
      const decision = inspect(JSON.parse(entry.json) as T, seq, window);
      if (decision.action === 'stop') break;
      lastScanned = seq;
      if (decision.action === 'skip') continue;
      rows.push({ seq, value: decision.value });
      if (rows.length >= limit) break;
    }
    return { rows, lastScanned, oldestSeq, gap: since < oldestSeq - 1 };
  }

  get stats() {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      dropped: this.dropped,
      evicted: this.evicted,
    };
  }
}
