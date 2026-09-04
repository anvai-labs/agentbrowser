/**
 * Bounded LRU cache (TD-BROWSER-9).
 *
 * A `Map` already preserves insertion order, so re-inserting a key on access
 * doubles as the LRU-promotion step - no separate linked list is needed.
 * `maxEntries: 0` disables caching outright (every `set` is immediately
 * evicted), which is the acceptance criterion for proving a cache is a pure
 * optimization: correctness must hold with the cache cold.
 */

export interface BoundedCacheOptions {
  /** Maximum entries retained; least-recently-used evicted first. */
  maxEntries: number;
}

export class BoundedCache<K, V> {
  private readonly store = new Map<K, V>();
  private readonly maxEntries: number;

  constructor(options: BoundedCacheOptions) {
    this.maxEntries = options.maxEntries;
  }

  get(key: K): V | undefined {
    const value = this.store.get(key);
    if (value === undefined) {
      return undefined;
    }
    // Re-insert to mark as most-recently-used.
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  set(key: K, value: V): void {
    this.store.delete(key);
    if (this.maxEntries <= 0) {
      // Caching disabled: never retain anything.
      return;
    }
    this.store.set(key, value);
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.store.delete(oldest);
    }
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}
