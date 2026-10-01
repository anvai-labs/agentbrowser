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
   * entry rather than failing.
   */
  entriesAfter(since: number, limit: number): { seq: number; value: T }[] {
    if (!Number.isSafeInteger(since) || !Number.isSafeInteger(limit) || limit < 1)
      throw new Error('Invalid ledger paging arguments');
    const out: { seq: number; value: T }[] = [];
    for (const [seq, entry] of this.entries) {
      if (seq <= since) continue;
      out.push({ seq, value: JSON.parse(entry.json) as T });
      if (out.length >= limit) break;
    }
    return out;
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
