import { describe, expect, it, vi } from 'vitest';
import { applyBountyDefaults, bountyPacing } from './bounty-defaults.js';

describe('T10 B1 bounty defaults', () => {
  it('defaults to headed, four hours, one hour idle and five scoped requests/s', () => {
    expect(applyBountyDefaults({ mode: 'bounty', scope: { allowedHosts: ['app.test'] } })).toEqual({
      mode: 'bounty',
      headless: false,
      ttlMs: 14400000,
      idleTimeoutMs: 3600000,
      scope: { allowedHosts: ['app.test'], rateLimit: { requests: 5, perSeconds: 1 } },
    });
  });
  it('honors explicit request settings and deployment timeouts without mutating input', () => {
    const input = {
      mode: 'bounty' as const,
      headless: true,
      ttlMs: 2000,
      scope: { allowedHosts: ['app.test'], rateLimit: { requests: 1, perSeconds: 3 } },
    };
    const before = structuredClone(input);
    const result = applyBountyDefaults(input, { ttlMs: 3000, idleTimeoutMs: 4000 });
    expect(result).toMatchObject({
      headless: true,
      ttlMs: 2000,
      idleTimeoutMs: 4000,
      scope: { rateLimit: { requests: 1, perSeconds: 3 } },
    });
    expect(input).toEqual(before);
  });
  it('does not claim or configure launch/pacing overrides for an attached operator browser', () => {
    expect(applyBountyDefaults({ cdpAttach: true }, { mode: 'bounty' })).toEqual({
      mode: 'bounty',
      cdpAttach: true,
      ttlMs: 14400000,
      idleTimeoutMs: 3600000,
    });
    expect(applyBountyDefaults({})).toEqual({});
  });
  it('paces unscoped contained traffic, preserves base checks and wakes refused on close', async () => {
    vi.useFakeTimers();
    try {
      const checkRequest = vi.fn(async () => {});
      const checkBodySize = vi.fn();
      const limiter = bountyPacing({ checkRequest, checkBodySize });
      const request = { hostname: 'app.test', url: 'https://app.test/' };
      await Promise.all(Array.from({ length: 5 }, () => limiter.policy.checkRequest(request)));
      const sixth = limiter.policy.checkRequest(request);
      let done = false;
      void sixth.then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await sixth;
      limiter.policy.checkBodySize?.(12);
      expect(checkBodySize).toHaveBeenCalledWith(12);
      const queued = Array.from({ length: 6 }, () => limiter.policy.checkRequest(request));
      const results = Promise.allSettled(queued);
      limiter.stop();
      expect((await results).every((r) => r.status === 'rejected')).toBe(true);
      expect(checkRequest).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
