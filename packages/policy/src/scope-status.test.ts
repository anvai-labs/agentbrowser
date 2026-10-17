// T10 M2: the scope in effect, budget and denials are readable, and a dry-run
// check judges the scope rules without spending budget or counting a denial.
import { describe, expect, it } from 'vitest';
import { NetworkPolicy } from './network-policy.js';
import { EngagementScopePolicy } from './scope-policy.js';

const base = () => new NetworkPolicy({ blockLoopback: false });
const deny = (promise: Promise<unknown>) =>
  promise.then(
    () => 'allowed',
    () => 'denied'
  );

describe('EngagementScopePolicy status and dry-run check', () => {
  it('reports the scope in effect, budget used/remaining and expiry', async () => {
    let now = 1_000;
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['in.example', '.sub.example'],
      pathRules: [{ prefix: '/api' }],
      allowedMethods: ['get', 'POST'],
      requestBudget: 3,
      expiresAt: 5_000,
      now: () => now,
    });
    await scope.checkRequest({
      hostname: 'in.example',
      url: 'http://in.example/api/a',
      method: 'GET',
    });
    expect(scope.status()).toEqual({
      allowedHosts: ['in.example', '.sub.example'],
      pathRules: [{ prefix: '/api' }],
      allowedMethods: ['GET', 'POST'],
      identityBindings: [],
      expiresAt: 5_000,
      expired: false,
      budget: { limit: 3, spent: 1, remaining: 2 },
      denials: {},
    });
    now = 5_000;
    expect(scope.status().expired).toBe(true);
  });

  it('counts denials by sub-code, on the wire and in the navigation preflight', async () => {
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['in.example'],
      allowedMethods: ['GET'],
    });
    await deny(scope.checkRequest({ hostname: 'out.example', url: 'http://out.example/' }));
    await deny(scope.preflightCheck({ hostname: 'out.example', url: 'http://out.example/' }));
    await deny(
      scope.checkRequest({ hostname: 'in.example', url: 'http://in.example/', method: 'DELETE' })
    );
    expect(scope.status().denials).toEqual({ SCOPE_HOST_DENIED: 2, SCOPE_METHOD_DENIED: 1 });
  });

  it('never reports an identity marker value', () => {
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['in.example'],
      identityBindings: [
        { header: 'X-Test-Identity', value: 'secret-token', allowedHosts: ['in.example'] },
      ],
    });
    const status = scope.status();
    expect(status.identityBindings).toEqual([
      { header: 'x-test-identity', allowedHosts: ['in.example'] },
    ]);
    expect(JSON.stringify(status)).not.toContain('secret-token');
  });

  it('dry-run check: judges the rules, spends no budget, counts no denial', async () => {
    const scope = new EngagementScopePolicy(base(), {
      allowedHosts: ['in.example'],
      requestBudget: 1,
    });
    expect(scope.check({ url: 'http://in.example/x' })).toEqual({ allowed: true });
    expect(scope.check({ url: 'http://out.example/x' })).toEqual({
      allowed: false,
      scope: 'SCOPE_HOST_DENIED',
    });
    expect(scope.status().budget).toEqual({ limit: 1, spent: 0, remaining: 1 });
    expect(scope.status().denials).toEqual({});
    await scope.checkRequest({ hostname: 'in.example', url: 'http://in.example/x' });
    // A spent budget is judged too, still without spending or counting.
    expect(scope.check({ url: 'http://in.example/y' })).toEqual({
      allowed: false,
      scope: 'SCOPE_BUDGET_EXHAUSTED',
    });
    expect(scope.status().denials).toEqual({});
  });
});
