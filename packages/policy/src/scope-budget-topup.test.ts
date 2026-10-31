import { expect, it, vi } from 'vitest';
import { EngagementScopePolicy } from './scope-policy.js';

it('tops up exhausted finite budget only after persistence and preserves denial and pacing counters', async () => {
  const scope = new EngagementScopePolicy(
    { checkRequest: async () => {} },
    { allowedHosts: ['app.test'], allowedMethods: ['GET'], requestBudget: 1 }
  );
  await scope.checkRequest({ hostname: 'app.test', url: 'https://app.test/', method: 'GET' });
  await expect(
    scope.checkRequest({ hostname: 'app.test', url: 'https://app.test/', method: 'GET' })
  ).rejects.toThrow('SCOPE_BUDGET_EXHAUSTED');
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const pending = scope.topUpBudget(5, 0, async () => held);
  expect(scope.status().budget).toEqual({ limit: 1, spent: 1, remaining: 0 });
  release();
  await pending;
  expect(scope.status()).toMatchObject({
    revision: 1,
    budget: { limit: 5, spent: 1, remaining: 4 },
    denials: { SCOPE_BUDGET_EXHAUSTED: 1 },
  });
  await expect(
    scope.checkRequest({ hostname: 'evil.test', url: 'https://evil.test/', method: 'GET' })
  ).rejects.toThrow('SCOPE_HOST_DENIED');
  await expect(
    scope.checkRequest({ hostname: 'app.test', url: 'https://app.test/', method: 'PUT' })
  ).rejects.toThrow('SCOPE_METHOD_DENIED');
  const persist = vi.fn(async () => {});
  await expect(scope.topUpBudget(6, 0, persist)).rejects.toThrow();
  expect(persist).not.toHaveBeenCalled();
  scope.stop('closed');
  await expect(scope.topUpBudget(6, 1, persist)).rejects.toThrow();
});
it('refuses unlimited, smaller, unsafe limits and failed persistence without granting', async () => {
  const unlimited = new EngagementScopePolicy(
    { checkRequest: async () => {} },
    { allowedHosts: ['app.test'] }
  );
  await expect(unlimited.topUpBudget(10, 0, async () => {})).rejects.toThrow();
  const finite = new EngagementScopePolicy(
    { checkRequest: async () => {} },
    { allowedHosts: ['app.test'], requestBudget: 2 }
  );
  for (const limit of [1, 2, Number.POSITIVE_INFINITY, 10000001])
    await expect(finite.topUpBudget(limit, 0, async () => {})).rejects.toThrow();
  await expect(
    finite.topUpBudget(10, 0, async () => {
      throw new Error('disk');
    })
  ).rejects.toThrow('disk');
  expect(finite.status()).toMatchObject({ revision: 0, budget: { limit: 2 } });
});
