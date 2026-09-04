/**
 * TDD Tests for BoundedCache (TD-BROWSER-9)
 */

import { describe, expect, it } from 'vitest';
import { BoundedCache } from './bounded-cache';

describe('BoundedCache', () => {
  it('should store and retrieve entries within capacity', () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 3 });
    cache.set('a', 1);
    cache.set('b', 2);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  it('should evict the least-recently-used entry once over capacity', () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // over capacity: 'a' (never touched) evicts first

    expect(cache.has('a')).toBe(false);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('should treat get() as promoting an entry to most-recently-used', () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // 'a' is now more recent than 'b'
    cache.set('c', 3); // over capacity: 'b' (least recently used) evicts, not 'a'

    expect(cache.has('b')).toBe(false);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('should disable caching entirely when maxEntries is 0', () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 0 });
    cache.set('a', 1);

    expect(cache.has('a')).toBe(false);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('should clear all entries', () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 5 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });
});
