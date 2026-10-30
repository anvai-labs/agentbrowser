import { expect, it, vi } from 'vitest';
import { EngagementScopePolicy } from './scope-policy.js';

const scope = () =>
  new EngagementScopePolicy(
    { checkRequest: vi.fn(async () => {}) },
    {
      allowedHosts: ['app.test'],
      assetHosts: [{ host: 'cdn.test', class: 'asset' }],
      requestHeaders: [{ header: 'x-research', value: 'private-marker' }],
      requestBudget: 10,
    }
  );
it('refuses asset entries inside a bare program subtree', () => {
  expect(
    () =>
      new EngagementScopePolicy(
        { checkRequest: async () => {} },
        {
          allowedHosts: ['example.com'],
          assetHosts: [{ host: 'cdn.example.com', class: 'asset' }],
        }
      )
  ).toThrow();
});
it('permits only static asset requests initiated by program documents', async () => {
  const policy = scope();
  await expect(
    policy.checkRequest({
      url: 'https://cdn.test/a.js',
      hostname: 'cdn.test',
      method: 'GET',
      resourceType: 'script',
      initiatorHost: 'app.test',
    })
  ).resolves.toBeUndefined();
  for (const extra of [
    { resourceType: 'document' },
    { resourceType: 'fetch' },
    { resourceType: 'xhr' },
    { resourceType: 'worker' },
    { resourceType: undefined },
    { initiatorHost: 'evil.test' },
    { method: 'POST' },
  ]) {
    await expect(
      policy.checkRequest({
        url: 'https://cdn.test/a',
        hostname: 'cdn.test',
        method: 'GET',
        resourceType: 'script',
        initiatorHost: 'app.test',
        ...extra,
      })
    ).rejects.toMatchObject({ details: { scope: 'SCOPE_HOST_DENIED' } });
  }
});
it('suppresses every program marker on asset hosts, including unrestricted marker definitions', () => {
  const policy = scope();
  expect(
    policy.headersForRequest?.('cdn.test', { 'X-Research': 'private-marker', accept: '*/*' })
  ).toEqual({ accept: '*/*', cookie: '' });
  expect(policy.injectedHeaderNames('cdn.test')).toEqual([]);
  expect(policy.headersForRequest?.('app.test', {})).toEqual({ 'x-research': 'private-marker' });
});
it('retains excludes, budgets and base denials on assets', async () => {
  const base = {
    checkRequest: vi.fn(async () => {
      throw new Error('base denied');
    }),
  };
  const policy = new EngagementScopePolicy(base, {
    allowedHosts: ['app.test'],
    assetHosts: [{ host: 'cdn.test', class: 'asset' }],
  });
  await expect(
    policy.checkRequest({
      url: 'https://cdn.test/a.js',
      hostname: 'cdn.test',
      method: 'GET',
      resourceType: 'script',
      initiatorHost: 'app.test',
    })
  ).rejects.toThrow('base denied');
  expect(base.checkRequest).toHaveBeenCalled();
});

it('refuses userinfo that the HTTP transport would otherwise turn into Basic authorization', async () => {
  await expect(
    scope().checkRequest({
      url: 'https://user:password@cdn.test/a.js',
      hostname: 'cdn.test',
      method: 'GET',
      resourceType: 'script',
      initiatorHost: 'app.test',
    })
  ).rejects.toMatchObject({ details: { scope: 'SCOPE_HOST_DENIED' } });
});
