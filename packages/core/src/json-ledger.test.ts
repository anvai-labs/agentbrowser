/**
 * TDD Tests for the JSON Ledger
 *
 * A count- and UTF-8-byte-bounded FIFO used for append-only records. The
 * behavioral contract: oversized entries are dropped (counted, never
 * inserted), oldest entries are evicted first under either bound, reads
 * return parsed values in insertion order, and stats expose the ledger's
 * accounting without exposing stored JSON.
 */

import { describe, expect, it } from 'vitest';
import { JsonLedger } from './json-ledger.js';

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('JsonLedger', () => {
  describe('construction', () => {
    it('accepts positive safe-integer limits', () => {
      expect(() => new JsonLedger({ maxEntries: 1, maxBytes: 1, maxEntryBytes: 1 })).not.toThrow();
    });

    it.each([
      ['maxEntries', { maxEntries: 0, maxBytes: 100, maxEntryBytes: 100 }],
      ['maxEntries', { maxEntries: -1, maxBytes: 100, maxEntryBytes: 100 }],
      ['maxEntries', { maxEntries: 1.5, maxBytes: 100, maxEntryBytes: 100 }],
      ['maxBytes', { maxEntries: 10, maxBytes: 0, maxEntryBytes: 100 }],
      ['maxBytes', { maxEntries: 10, maxBytes: -5, maxEntryBytes: 100 }],
      ['maxEntryBytes', { maxEntries: 10, maxBytes: 100, maxEntryBytes: 0 }],
      ['maxEntryBytes', { maxEntries: 10, maxBytes: 100, maxEntryBytes: 2.5 }],
    ])('rejects non-positive or non-integer %s', (_field, options) => {
      expect(() => new JsonLedger(options)).toThrow('Ledger limits must be positive safe integers');
    });
  });

  describe('admission', () => {
    it('accepts entries at or under the entry-byte limit', () => {
      const ledger = new JsonLedger<{ v: string }>({
        maxEntries: 10,
        maxBytes: 1000,
        maxEntryBytes: bytesOf({ v: 'exactly' }),
      });

      expect(ledger.push({ v: 'exactly' })).toBe(true);
      expect(ledger.stats).toMatchObject({ entries: 1, dropped: 0 });
    });

    it('drops and counts entries larger than maxEntryBytes', () => {
      const ledger = new JsonLedger<{ v: string }>({
        maxEntries: 10,
        maxBytes: 1000,
        maxEntryBytes: 8,
      });

      expect(ledger.push({ v: 'way too big for the limit' })).toBe(false);
      expect(ledger.stats).toEqual({ entries: 0, bytes: 0, dropped: 1, evicted: 0 });
    });

    it('drops entries that exceed maxBytes even when under maxEntryBytes', () => {
      const value = { v: 'x'.repeat(50) };
      const ledger = new JsonLedger<typeof value>({
        maxEntries: 10,
        maxBytes: bytesOf(value) - 1,
        maxEntryBytes: bytesOf(value) + 100,
      });

      expect(ledger.push(value)).toBe(false);
      expect(ledger.stats).toMatchObject({ entries: 0, dropped: 1 });
    });

    it('tracks bytes for accepted entries', () => {
      const ledger = new JsonLedger<{ v: string }>({
        maxEntries: 10,
        maxBytes: 1000,
        maxEntryBytes: 1000,
      });

      const value = { v: 'a' };
      ledger.push(value);
      ledger.push(value);

      expect(ledger.stats.bytes).toBe(bytesOf(value) * 2);
    });
  });

  describe('FIFO eviction', () => {
    it('evicts the oldest entry on count pressure', () => {
      const ledger = new JsonLedger<number>({ maxEntries: 2, maxBytes: 1000, maxEntryBytes: 100 });

      ledger.push(1);
      ledger.push(2);
      expect(ledger.push(3)).toBe(true);

      expect(ledger.toArray()).toEqual([2, 3]);
      expect(ledger.stats).toMatchObject({ entries: 2, evicted: 1 });
    });

    it('evicts oldest-first on byte pressure until the new entry fits', () => {
      const a = { id: 'a' };
      const b = { id: 'b' };
      const c = { id: 'c' };
      // Room for exactly a + b: pushing c must evict a, and c must then fit.
      const ledger = new JsonLedger<typeof a>({
        maxEntries: 10,
        maxBytes: bytesOf(a) + bytesOf(b),
        maxEntryBytes: bytesOf(a),
      });

      ledger.push(a);
      ledger.push(b);
      expect(ledger.push(c)).toBe(true);

      expect(ledger.toArray()).toEqual([b, c]);
      expect(ledger.stats).toMatchObject({ entries: 2, evicted: 1 });
      expect(ledger.stats.bytes).toBe(bytesOf(b) + bytesOf(c));
    });

    it('evicts every stored entry when one new entry cannot fit beside any of them', () => {
      const small = { id: 's' };
      const huge = { id: 'h'.repeat(40) };
      const ledger = new JsonLedger<typeof huge>({
        maxEntries: 10,
        // One byte short of holding both: the huge entry must evict `small`.
        maxBytes: bytesOf(small) + bytesOf(huge) - 1,
        maxEntryBytes: bytesOf(huge),
      });

      ledger.push(small);
      expect(ledger.push(huge)).toBe(true);

      expect(ledger.toArray()).toEqual([huge]);
      expect(ledger.stats).toMatchObject({ entries: 1, evicted: 1 });
    });
  });

  describe('reads and ownership', () => {
    it('returns parsed values in insertion order', () => {
      const ledger = new JsonLedger<{ n: number; tags: string[] }>({
        maxEntries: 5,
        maxBytes: 1000,
        maxEntryBytes: 1000,
      });

      ledger.push({ n: 1, tags: ['x'] });
      ledger.push({ n: 2, tags: ['y'] });
      ledger.push({ n: 3, tags: [] });

      expect(ledger.toArray()).toEqual([
        { n: 1, tags: ['x'] },
        { n: 2, tags: ['y'] },
        { n: 3, tags: [] },
      ]);
    });

    it('returns an empty array when nothing was stored', () => {
      const ledger = new JsonLedger<number>({ maxEntries: 5, maxBytes: 100, maxEntryBytes: 100 });

      expect(ledger.toArray()).toEqual([]);
    });

    it('serializes on push, so later mutation of the pushed value cannot drift stored state', () => {
      const ledger = new JsonLedger<{ v: string }>({
        maxEntries: 5,
        maxBytes: 1000,
        maxEntryBytes: 1000,
      });

      const value = { v: 'original' };
      ledger.push(value);
      value.v = 'mutated after push';

      expect(ledger.toArray()).toEqual([{ v: 'original' }]);
    });

    it('reports the full accounting in stats', () => {
      const ledger = new JsonLedger<number>({ maxEntries: 2, maxBytes: 1000, maxEntryBytes: 100 });

      expect(ledger.stats).toEqual({ entries: 0, bytes: 0, dropped: 0, evicted: 0 });

      ledger.push(1); // stored
      ledger.push('x'.repeat(101) as unknown as number); // dropped: 103 bytes over the 100-byte entry cap
      ledger.push(2); // stored
      ledger.push(3); // evicts 1

      expect(ledger.stats).toEqual({
        entries: 2,
        bytes: bytesOf(2) + bytesOf(3),
        dropped: 1,
        evicted: 1,
      });
    });
  });
});

describe('paging', () => {
  const make = () =>
    new JsonLedger<string>({ maxEntries: 5, maxBytes: 10_000, maxEntryBytes: 1_000 });

  it('returns entries after the cursor, capped by limit', () => {
    const ledger = make();
    for (const value of ['a', 'b', 'c', 'd']) ledger.push(value);
    expect(ledger.entriesAfter(-1, 10).map((entry) => entry.value)).toEqual(['a', 'b', 'c', 'd']);
    expect(ledger.entriesAfter(1, 10).map((entry) => entry.value)).toEqual(['c', 'd']);
    expect(ledger.entriesAfter(1, 1).map((entry) => entry.value)).toEqual(['c']);
    const page = ledger.entriesAfter(1, 10);
    expect(page.map((entry) => entry.seq)).toEqual([2, 3]);
  });

  it('a cursor below the retained window re-reads from the oldest kept entry', () => {
    const ledger = make();
    for (const value of ['a', 'b', 'c', 'd']) ledger.push(value);
    ledger.push('e');
    ledger.push('f');
    expect(ledger.entriesAfter(0, 10).map((entry) => entry.value)).toEqual([
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
    expect(ledger.entriesAfter(5, 10)).toEqual([]);
  });

  it('rejects invalid paging arguments', () => {
    const ledger = make();
    expect(() => ledger.entriesAfter(Number.NaN, 5)).toThrow();
    expect(() => ledger.entriesAfter(0, 0)).toThrow();
  });
});

describe('filtered paging with gap reporting', () => {
  type Event = { type: string; n: number };
  const make = (maxEntries = 100) =>
    new JsonLedger<Event>({ maxEntries, maxBytes: 100_000, maxEntryBytes: 1_000 });

  it('returns only matching rows and advances the cursor past skipped rows', () => {
    const ledger = make();
    for (let n = 0; n < 10; n++) ledger.push({ type: n % 5 === 0 ? 'rare' : 'common', n });
    const isRare = (event: Event) => event.type === 'rare';

    const first = ledger.page(-1, 1, isRare);
    expect(first.rows.map((row) => row.value.n)).toEqual([0]);
    expect(first.lastScanned).toBe(0);

    const second = ledger.page(first.lastScanned, 1, isRare);
    expect(second.rows.map((row) => row.value.n)).toEqual([5]);
    expect(second.lastScanned).toBe(5);

    // No further matches: the cursor still moves to the end of the scanned window.
    const third = ledger.page(second.lastScanned, 1, isRare);
    expect(third.rows).toEqual([]);
    expect(third.lastScanned).toBe(9);
  });

  it('concatenated pages equal the unpaged filtered list', () => {
    const ledger = make();
    for (let n = 0; n < 37; n++) ledger.push({ type: n % 3 === 0 ? 'a' : 'b', n });
    const isA = (event: Event) => event.type === 'a';
    const seen: number[] = [];
    let cursor = -1;
    for (let guard = 0; guard < 100; guard++) {
      const page = ledger.page(cursor, 4, isA);
      seen.push(...page.rows.map((row) => row.value.n));
      if (page.lastScanned === cursor) break;
      cursor = page.lastScanned;
    }
    expect(seen).toEqual(
      ledger
        .toArray()
        .filter(isA)
        .map((event) => event.n)
    );
  });

  it('keeps the cursor unchanged when nothing lies after it', () => {
    const ledger = make();
    ledger.push({ type: 'a', n: 0 });
    expect(ledger.page(0, 5)).toMatchObject({ rows: [], lastScanned: 0 });
  });

  it('reports the oldest retained sequence and a gap after eviction', () => {
    const ledger = make(3);
    for (let n = 0; n < 3; n++) ledger.push({ type: 'a', n });
    const before = ledger.page(-1, 10);
    expect(before.oldestSeq).toBe(0);
    expect(before.gap).toBe(false);

    for (let n = 3; n < 8; n++) ledger.push({ type: 'a', n });
    // Retained: 5, 6, 7. A reader whose cursor is 2 lost 3 and 4.
    const after = ledger.page(2, 10);
    expect(after.oldestSeq).toBe(5);
    expect(after.gap).toBe(true);
    expect(after.rows.map((row) => row.seq)).toEqual([5, 6, 7]);
    // A cursor exactly one below the window lost nothing.
    expect(ledger.page(4, 10).gap).toBe(false);
    // Reading from the start after eviction is also a gap.
    expect(ledger.page(-1, 10).gap).toBe(true);
  });

  it('reports no gap on an empty ledger', () => {
    expect(make().page(-1, 10)).toEqual({ rows: [], lastScanned: -1, oldestSeq: 0, gap: false });
  });

  it('rejects invalid paging arguments', () => {
    expect(() => make().page(Number.NaN, 5)).toThrow();
    expect(() => make().page(0, 0)).toThrow();
  });
});
