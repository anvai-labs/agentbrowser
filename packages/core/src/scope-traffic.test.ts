import { expect, it } from 'vitest';
import { PageCostHistory, ScopeTraffic } from './scope-traffic.js';

it('counts denied PUT by host class without suggesting authority', () => {
  const traffic = new ScopeTraffic({
    allowedHosts: ['vinted.com'],
    assetHosts: [{ host: 'cdn.test', class: 'asset' }],
  });
  traffic.note(
    { method: 'PUT', url: 'https://vinted.com/api?secret=x', scope: 'SCOPE_METHOD_DENIED' },
    true
  );
  traffic.note({ method: 'GET', url: 'https://cdn.test/a' }, false);
  expect(traffic.summary()).toEqual({
    rows: [
      { method: 'GET', hostClass: 'asset', requests: 1, denied: 0 },
      { method: 'PUT', hostClass: 'program', requests: 1, denied: 1 },
    ],
    truncated: false,
  });
});
it('warns below five times tenant-local median and bounds history', () => {
  const history = new PageCostHistory();
  for (const cost of [150, 200, 300]) history.note('one', 'vinted.com', cost);
  expect(history.warning('one', ['vinted.com'], 200)).toContain('1000');
  expect(history.warning('two', ['vinted.com'], 200)).toBeUndefined();
  expect(history.warning('one', ['other.com'], 200)).toBeUndefined();
  expect(history.warning('one', ['vinted.com'], 1000)).toBeUndefined();
});
it('classifies new requests against the effective amended scope and retains historical classes', () => {
  const traffic = new ScopeTraffic({ allowedHosts: ['app.test'] });
  traffic.note({ method: 'GET', url: 'https://cdn.test/a' }, true);
  traffic.note({ method: 'GET', url: 'https://cdn.test/a' }, false, {
    allowedHosts: ['app.test'],
    assetHosts: [{ host: 'cdn.test' }],
  });
  expect(traffic.summary().rows).toEqual([
    { method: 'GET', hostClass: 'asset', requests: 1, denied: 0 },
    { method: 'GET', hostClass: 'other', requests: 1, denied: 1 },
  ]);
});
