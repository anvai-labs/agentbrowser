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

const resourceScope = () =>
  new EngagementScopePolicy(
    { checkRequest: vi.fn(async () => {}) },
    {
      allowedHosts: ['app.test'],
      assetHosts: [
        { host: 'cdn.test', class: 'asset' },
        { host: 'beacon.test', class: 'resource', category: 'captcha' },
      ],
      allowedMethods: ['GET'],
      requestBudget: 100,
    }
  );
it('resource-class hosts admit the functional lane: page-initiated fetch/XHR with GET/HEAD/OPTIONS/POST', async () => {
  const policy = resourceScope();
  for (const lane of [
    { resourceType: 'xhr', method: 'POST' },
    { resourceType: 'fetch', method: 'POST' },
    { resourceType: 'fetch', method: 'GET' },
    { resourceType: 'fetch', method: 'OPTIONS' },
    { resourceType: 'script', method: 'GET' },
  ]) {
    await expect(
      policy.checkRequest({
        url: 'https://beacon.test/collect',
        hostname: 'beacon.test',
        initiatorHost: 'app.test',
        ...lane,
      }),
      JSON.stringify(lane)
    ).resolves.toBeUndefined();
  }
});
it('resource-class hosts still refuse navigations, mutations beyond POST, missing or foreign attribution, and credential URLs', async () => {
  const policy = resourceScope();
  for (const extra of [
    { resourceType: 'document', method: 'GET' },
    { resourceType: 'xhr', method: 'PUT' },
    { resourceType: 'xhr', method: 'DELETE' },
    { resourceType: 'xhr', method: 'POST', initiatorHost: 'evil.test' },
    { resourceType: 'xhr', method: 'POST', initiatorHost: undefined },
    { resourceType: 'websocket', method: 'GET' },
  ]) {
    await expect(
      policy.checkRequest({
        url: 'https://beacon.test/collect',
        hostname: 'beacon.test',
        initiatorHost: 'app.test',
        method: 'GET',
        resourceType: 'fetch',
        ...extra,
      }),
      JSON.stringify(extra)
    ).rejects.toMatchObject({ details: { scope: 'SCOPE_HOST_DENIED' } });
  }
  await expect(
    policy.checkRequest({
      url: 'https://user:pass@beacon.test/collect',
      hostname: 'beacon.test',
      method: 'POST',
      resourceType: 'xhr',
      initiatorHost: 'app.test',
    })
  ).rejects.toMatchObject({ details: { scope: 'SCOPE_HOST_DENIED' } });
});
it('a resource host’s POST is governed by its class, not the program method list (P1-5)', async () => {
  const policy = resourceScope();
  // Program methods are GET-only; the vendor beacon still POSTs.
  await expect(
    policy.checkRequest({
      url: 'https://beacon.test/collect',
      hostname: 'beacon.test',
      method: 'POST',
      resourceType: 'xhr',
      initiatorHost: 'app.test',
    })
  ).resolves.toBeUndefined();
  // The program method floor still governs program hosts.
  await expect(
    policy.checkRequest({
      url: 'https://app.test/api',
      hostname: 'app.test',
      method: 'POST',
    })
  ).rejects.toMatchObject({ details: { scope: 'SCOPE_METHOD_DENIED' } });
});
it('resource-class traffic consumes budget and is scrubbed like asset traffic', async () => {
  const policy = resourceScope();
  for (let i = 0; i < 3; i += 1)
    await policy.checkRequest({
      url: 'https://beacon.test/collect',
      hostname: 'beacon.test',
      method: 'POST',
      resourceType: 'xhr',
      initiatorHost: 'app.test',
    });
  expect(policy.status().budget.spent).toBeGreaterThanOrEqual(3);
});
