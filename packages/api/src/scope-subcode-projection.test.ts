// T10 M2: every engagement-scope denial the policy raises survives the bounded
// client projection that the CLI and MCP use for navigate refusals.
import { EngagementScopePolicy, NetworkPolicy } from '@agentbrowser/policy';
import { navigationFailureDetail, SCOPE_DENIAL_CODES } from '@agentbrowser/protocol';
import { expect, it } from 'vitest';

const deniedBy = async (check: () => Promise<void>) => {
  try {
    await check();
  } catch (error) {
    return error;
  }
  throw new Error('expected a scope denial');
};

it('projects each scope denial with its sub-code', async () => {
  const base = () => new NetworkPolicy({ blockLoopback: false });
  const host = 'in.example';
  const cases: Array<[string, () => Promise<void>]> = [
    [
      'SCOPE_HOST_DENIED',
      () =>
        new EngagementScopePolicy(base(), { allowedHosts: [host] }).checkRequest({
          hostname: 'out.example',
          url: 'http://out.example/',
        }),
    ],
    [
      'SCOPE_PATH_DENIED',
      () =>
        new EngagementScopePolicy(base(), {
          allowedHosts: [host],
          pathRules: [{ prefix: '/api' }],
        }).checkRequest({ hostname: host, url: `http://${host}/admin` }),
    ],
    [
      'SCOPE_METHOD_DENIED',
      () =>
        new EngagementScopePolicy(base(), {
          allowedHosts: [host],
          allowedMethods: ['GET'],
        }).checkRequest({ hostname: host, url: `http://${host}/`, method: 'DELETE' }),
    ],
    [
      'SCOPE_EXPIRED',
      () =>
        new EngagementScopePolicy(base(), {
          allowedHosts: [host],
          expiresAt: 1,
          now: () => 2,
        }).checkRequest({ hostname: host, url: `http://${host}/` }),
    ],
    [
      'SCOPE_BUDGET_EXHAUSTED',
      async () => {
        const scope = new EngagementScopePolicy(base(), { allowedHosts: [host], requestBudget: 1 });
        await scope.checkRequest({ hostname: host, url: `http://${host}/a` });
        await scope.checkRequest({ hostname: host, url: `http://${host}/b` });
      },
    ],
    [
      'SCOPE_IDENTITY_DENIED',
      () =>
        new EngagementScopePolicy(base(), {
          allowedHosts: [host, 'other.example'],
          identityBindings: [{ header: 'x-id', value: 'v', allowedHosts: [host] }],
        }).checkRequest({
          hostname: 'other.example',
          url: 'http://other.example/',
          headers: { 'x-id': 'v' },
        }),
    ],
  ];
  expect(cases.map(([code]) => code).sort()).toEqual([...SCOPE_DENIAL_CODES].sort());
  for (const [code, check] of cases) {
    const projected = navigationFailureDetail(await deniedBy(check));
    expect(projected?.details).toEqual({ reason: 'egress_policy', scope: code });
  }
});
