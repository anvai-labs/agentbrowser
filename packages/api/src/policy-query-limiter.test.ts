import { describe, expect, it } from 'vitest';
import { TokenBucketLimiter } from './policy-query-limiter.js';

describe('TokenBucketLimiter', () => {
  it('bursts to capacity then refuses until refill', () => {
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerInterval: 1, intervalMs: 1000 });
    const t0 = 1_000_000;
    expect([limiter.take('a', t0), limiter.take('a', t0 + 1), limiter.take('a', t0 + 2)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.take('a', t0 + 3)).toBe(false);
    // One interval refills exactly one token.
    expect(limiter.take('a', t0 + 1000)).toBe(true);
    expect(limiter.take('a', t0 + 1001)).toBe(false);
  });

  it('buckets are per tenant, and undefined shares one bucket', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerInterval: 1, intervalMs: 1000 });
    const t0 = 5_000_000;
    expect(limiter.take('a', t0)).toBe(true);
    expect(limiter.take('b', t0)).toBe(true);
    expect(limiter.take('a', t0 + 1)).toBe(false);
    expect(limiter.take(undefined, t0)).toBe(true);
    expect(limiter.take(undefined, t0 + 1)).toBe(false);
    expect(limiter.size).toBe(3);
  });

  it('caps tracked tenants, evicting the least recently used', () => {
    const limiter = new TokenBucketLimiter({
      capacity: 1,
      refillPerInterval: 1,
      intervalMs: 1000,
      maxTenants: 2,
    });
    const t0 = 0;
    limiter.take('a', t0);
    limiter.take('b', t0);
    limiter.take('a', t0 + 1); // refresh a
    limiter.take('c', t0 + 2); // evicts b
    expect(limiter.size).toBe(2);
    // b was evicted: a fresh bucket at full capacity.
    expect(limiter.take('b', t0 + 3)).toBe(true);
    expect(limiter.size).toBe(2);
  });

  it('never exceeds capacity across slow refills', () => {
    const limiter = new TokenBucketLimiter({
      capacity: 2,
      refillPerInterval: 10,
      intervalMs: 1000,
    });
    const t0 = 0;
    limiter.take('a', t0);
    limiter.take('a', t0);
    // Refilled to capacity: exactly two more succeed, the third does not.
    expect(limiter.take('a', t0 + 60_000)).toBe(true);
    expect(limiter.take('a', t0 + 60_001)).toBe(true);
    expect(limiter.take('a', t0 + 60_002)).toBe(false);
  });
});
