// T10 M3: rateLimit paces in-scope traffic (waits, never denies).
import { describe, expect, it } from 'vitest';
import { NetworkPolicy } from './network-policy.js';
import { EngagementScopePolicy } from './scope-policy.js';

const base = () => new NetworkPolicy({ blockLoopback: false });
const req = (path = '/') => ({
  hostname: 'app.example',
  url: `https://app.example${path}`,
  method: 'GET',
});

/** A virtual clock: sleep advances time instantly and records each wait. */
function virtualClock() {
  let now = 1_000_000;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    waits,
  };
}

describe('EngagementScopePolicy rateLimit (T10 M3)', () => {
  it('admits up to N requests per window without waiting, then paces the next', async () => {
    const clock = virtualClock();
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      rateLimit: { requests: 2, perSeconds: 1 },
      now: clock.now,
      sleep: clock.sleep,
    });
    await scope.checkRequest(req('/a'));
    await scope.checkRequest(req('/b'));
    expect(clock.waits).toEqual([]);
    await scope.checkRequest(req('/c'));
    // The oldest of the two admitted requests leaves the 1 s window after 1000 ms.
    expect(clock.waits).toEqual([1000]);
    expect(scope.status().rateLimit).toEqual({ requests: 2, perSeconds: 1, paced: 1 });
  });

  it('never lets concurrent requests burst past the limit', async () => {
    const clock = virtualClock();
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      rateLimit: { requests: 1, perSeconds: 2 },
      now: clock.now,
      sleep: clock.sleep,
    });
    await Promise.all([1, 2, 3].map((n) => scope.checkRequest(req(`/${n}`))));
    // One request per 2 s window: the second and third each wait a full window, in turn.
    expect(clock.waits).toEqual([2000, 2000]);
    expect(scope.status().rateLimit?.paced).toBe(2);
  });

  it('a request after the window has passed is not paced', async () => {
    const clock = virtualClock();
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      rateLimit: { requests: 1, perSeconds: 1 },
      now: clock.now,
      sleep: clock.sleep,
    });
    await scope.checkRequest(req('/a'));
    clock.advance(1500);
    await scope.checkRequest(req('/b'));
    expect(clock.waits).toEqual([]);
  });

  it('denied requests are not counted and never wait', async () => {
    const clock = virtualClock();
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      rateLimit: { requests: 1, perSeconds: 10 },
      now: clock.now,
      sleep: clock.sleep,
    });
    await scope.checkRequest(req('/a'));
    await expect(
      scope.checkRequest({ hostname: 'evil.example', url: 'https://evil.example/', method: 'GET' })
    ).rejects.toMatchObject({ details: { scope: 'SCOPE_HOST_DENIED' } });
    expect(clock.waits).toEqual([]);
  });

  it('every redirect hop is paced; the dry run and preflight never wait', async () => {
    const clock = virtualClock();
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      rateLimit: { requests: 1, perSeconds: 1 },
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(scope.check({ url: 'https://app.example/' })).toEqual({ allowed: true });
    await scope.preflightCheck(req('/p'));
    expect(clock.waits).toEqual([]);
    await scope.checkRedirectChain([
      { url: 'https://app.example/1' },
      { url: 'https://app.example/2' },
    ]);
    expect(clock.waits).toEqual([1000]);
  });

  it('omits rateLimit from status when unset', () => {
    const scope = new EngagementScopePolicy(base(), { allowedHosts: ['app.example'] });
    expect(scope.status()).not.toHaveProperty('rateLimit');
  });
});
