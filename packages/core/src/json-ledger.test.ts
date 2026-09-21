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
