import { expect, it } from 'vitest';
import { adoptAssetCandidates, summarizeDeniedHosts } from './scope-assets.js';

it('attributes a redirected denial to the actual destination and counts typed denials', () => {
  const result = summarizeDeniedHosts([
    {
      type: 'request.failed',
      data: {
        url: 'https://app.test/go',
        hostname: 'app.test',
        redirect: 'https://cdn.test/a.js',
        scope: 'SCOPE_HOST_DENIED',
        resourceType: 'script',
        method: 'GET',
      },
    },
  ]);
  expect(result.hosts).toEqual([expect.objectContaining({ hostname: 'cdn.test', count: 1 })]);
});
it('adopts only static candidates; program hosts and exclusions never become assets', () => {
  const entries = [
    {
      hostname: 'cdn.test',
      count: 2,
      codes: { SCOPE_HOST_DENIED: 2 },
      resourceTypes: { script: 2 },
    },
    {
      hostname: 'app.test',
      count: 1,
      codes: { SCOPE_HOST_DENIED: 1 },
      resourceTypes: { script: 1 },
    },
    {
      hostname: 'blocked.test',
      count: 1,
      codes: { SCOPE_HOST_DENIED: 1 },
      resourceTypes: { script: 1 },
    },
    {
      hostname: 'other.test',
      count: 1,
      codes: { SCOPE_HOST_DENIED: 1 },
      resourceTypes: { document: 1 },
    },
  ];
  const result = adoptAssetCandidates(
    {
      allowedHosts: ['app.test'],
      excludeHosts: ['blocked.test'],
      requestHeaders: [{ header: 'x-research', value: 'private-marker' }],
    },
    entries
  );
  expect(result.assetHosts).toEqual([{ host: 'cdn.test', class: 'asset' }]);
  expect(result.allowedHosts).toEqual(['app.test']);
  expect(result.requestHeaders).toEqual([{ header: 'x-research', value: 'private-marker' }]);
});

it('does not adopt a parent asset host which would cover a program child', () => {
  const next = adoptAssetCandidates({ allowedHosts: ['api.example.com'] }, [
    {
      hostname: 'example.com',
      count: 1,
      codes: { SCOPE_HOST_DENIED: 1 },
      resourceTypes: { script: 1 },
    },
  ]);
  expect(next.assetHosts).toBeUndefined();
});
