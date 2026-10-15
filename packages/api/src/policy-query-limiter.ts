/**
 * TD-BROWSER-15 phase 5: the bounded per-tenant token bucket for the policy
 * query routes. No HTTP rate limiter exists today; this one is deliberately
 * tiny — capacity + refill per interval, one bucket per tenant (undefined
 * tenants share the no-keys bucket), a fixed map bound, and no timers: tokens
 * refill on read (lazy), so an idle bucket costs nothing.
 */

export interface TokenBucketOptions {
  /** Bucket capacity; also the burst size. */
  capacity: number;
  /** Tokens added per refill interval. */
  refillPerInterval: number;
  /** Refill interval in milliseconds. */
  intervalMs: number;
  /** Maximum tracked tenants; evicting the least recently used. */
  maxTenants?: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: TokenBucketOptions) {}

  /** True when a token was taken; false when the bucket is empty. */
  take(key = 'local', now: number = Date.now()): boolean {
    const { capacity, refillPerInterval, intervalMs } = this.options;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      this.evictIfNeeded();
      bucket = { tokens: capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    } else {
      // LRU touch.
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
    }
    const elapsed = now - bucket.lastRefill;
    if (elapsed > 0) {
      const refilled = Math.floor((elapsed / intervalMs) * refillPerInterval);
      if (refilled > 0) {
        bucket.tokens = Math.min(capacity, bucket.tokens + refilled);
        bucket.lastRefill = now;
      }
    }
    if (bucket.tokens <= 0) return false;
    bucket.tokens -= 1;
    return true;
  }

  get size(): number {
    return this.buckets.size;
  }

  private evictIfNeeded(): void {
    const max = this.options.maxTenants ?? 1024;
    if (this.buckets.size < max) return;
    const oldest = this.buckets.keys().next().value;
    if (oldest !== undefined) this.buckets.delete(oldest);
  }
}
