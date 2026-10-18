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

  it('denies SCOPE_RATE_LIMITED instead of holding a request past the pacing cap', async () => {
    const clock = virtualClock();
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      rateLimit: { requests: 1, perSeconds: 60 },
      now: clock.now,
      sleep: clock.sleep,
    });
    await scope.checkRequest(req('/a'));
    await expect(scope.checkRequest(req('/b'))).rejects.toMatchObject({
      details: { scope: 'SCOPE_RATE_LIMITED' },
    });
    // Nothing waited: the request is refused now, not sent a minute after its caller gave up.
    expect(clock.waits).toEqual([]);
    expect(scope.status().denials).toEqual({ SCOPE_RATE_LIMITED: 1 });
  });

  it('counts time spent queued toward the cap', async () => {
    const clock = virtualClock();
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      rateLimit: { requests: 1, perSeconds: 10 },
      now: clock.now,
      sleep: clock.sleep,
    });
    const results = await Promise.allSettled(
      [1, 2, 3].map((n) => scope.checkRequest(req(`/${n}`)))
    );
    // The second waits 10 s; the third would wait 20 s in all, past the 15 s cap.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect((results[2] as PromiseRejectedResult).reason).toMatchObject({
      details: { scope: 'SCOPE_RATE_LIMITED' },
    });
  });

  it('stop() wakes waiting requests at once and they are denied', async () => {
    let wakeups = 0;
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      rateLimit: { requests: 1, perSeconds: 5 },
      // A sleep that only ends when aborted: without the wake-up these requests hang.
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => {
            wakeups += 1;
            resolve();
          })
        ),
    });
    await scope.checkRequest(req('/a'));
    const waiting = scope.checkRequest(req('/b'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    scope.stop('session closing');
    await expect(waiting).rejects.toMatchObject({ details: { scope: 'SCOPE_LEDGER_UNAVAILABLE' } });
    expect(wakeups).toBe(1);
  });

  it('a scope that expires during the wait denies after waking', async () => {
    const clock = virtualClock();
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      rateLimit: { requests: 1, perSeconds: 1 },
      expiresAt: clock.now() + 500,
      now: clock.now,
      sleep: clock.sleep,
    });
    await scope.checkRequest(req('/a'));
    await expect(scope.checkRequest(req('/b'))).rejects.toMatchObject({
      details: { scope: 'SCOPE_EXPIRED' },
    });
  });

  it('a timer that wakes early never admits two requests in one window', async () => {
    let now = 1_000_000;
    const admissions: number[] = [];
    const scope = new EngagementScopePolicy(
      {
        checkRequest: async () => {
          admissions.push(now);
        },
      },
      {
        allowedHosts: ['app.example'],
        rateLimit: { requests: 1, perSeconds: 1 },
        now: () => now,
        // Wakes 1 ms early, as Node timers against Date.now() can.
        sleep: async (ms) => {
          now += Math.max(1, ms - 1);
        },
      }
    );
    for (const n of [1, 2, 3]) await scope.checkRequest(req(`/${n}`));
    for (let k = 1; k < admissions.length; k += 1)
      expect(admissions[k]! - admissions[k - 1]!).toBeGreaterThanOrEqual(1000);
  });

  it('the window is exclusive at its edge: a request exactly one window later is not paced', async () => {
    const clock = virtualClock();
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['app.example'],
      rateLimit: { requests: 1, perSeconds: 1 },
      now: clock.now,
      sleep: clock.sleep,
    });
    await scope.checkRequest(req('/a'));
    clock.advance(1000);
    await scope.checkRequest(req('/b'));
    expect(clock.waits).toEqual([]);
    clock.advance(999);
    await scope.checkRequest(req('/c'));
    expect(clock.waits).toEqual([1]);
  });
});
