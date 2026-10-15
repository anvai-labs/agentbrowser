export interface JsonLedgerOptions {
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
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

  /** Entries with sequence > since, oldest first, capped at limit. Cursors
   * are the entry sequence numbers; eviction simply removes low sequences,
   * so a cursor below the retained window re-reads from the oldest kept
   * entry rather than failing; `page` reports that as a gap.
   */
  entriesAfter(since: number, limit: number): { seq: number; value: T }[] {
    return this.page(since, limit).rows;
  }

  /** Filtered paging. Up to `limit` matching entries with sequence > since.
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

  get stats() {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      dropped: this.dropped,
      evicted: this.evicted,
    };
  }
}
