import { expect, it, vi } from 'vitest';
import { EngagementScopePolicy } from './scope-policy.js';

it('acknowledges an asset-only append before activating it and preserves budget/markers', async () => {
  const scope = new EngagementScopePolicy(
    { checkRequest: async () => {} },
    {
      allowedHosts: ['app.test'],
      requestBudget: 20,
      requestHeaders: [{ header: 'x-research', value: 'private-marker' }],
    }
  );
  await scope.checkRequest({ hostname: 'app.test', url: 'https://app.test/', method: 'GET' });
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((r) => {
    entered = r;
  });
  const held = new Promise<void>((r) => {
    release = r;
  });
  const append = scope.appendAssets([{ host: 'cdn.test', class: 'asset' }], 0, async () => {
    entered();
    await held;
  });
  await enteredPromise;
  expect(scope.status().assetHosts).toBeUndefined();
  release();
  await append;
  expect(scope.status()).toMatchObject({
    revision: 1,
    allowedHosts: ['app.test'],
    budget: { spent: 1, remaining: 19 },
  });
  expect(scope.injectedHeaderNames('cdn.test')).toEqual([]);
  await expect(
    scope.appendAssets([{ host: 'other.test', class: 'asset' }], 0, async () => {})
  ).rejects.toThrow();
});
it('refuses failed persistence, program overlap and a stopped session without activating hosts', async () => {
  const scope = new EngagementScopePolicy(
    { checkRequest: async () => {} },
    { allowedHosts: ['app.test'] }
  );
  await expect(
    scope.appendAssets([{ host: 'cdn.test', class: 'asset' }], 0, async () => {
      throw new Error('disk');
    })
  ).rejects.toThrow();
  expect(scope.status().assetHosts).toBeUndefined();
  const persist = vi.fn(async () => {});
  await expect(
    scope.appendAssets([{ host: 'app.test', class: 'asset' }], 0, persist)
  ).rejects.toThrow();
  expect(persist).not.toHaveBeenCalled();
  scope.stop('closing');
  await expect(
    scope.appendAssets([{ host: 'cdn.test', class: 'asset' }], 0, persist)
  ).rejects.toThrow();
});
