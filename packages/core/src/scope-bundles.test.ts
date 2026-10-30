import { expect, it } from 'vitest';
import { importProgramScope } from './program-scope-import.js';

it('adds explicit retail support-host classes without changing program targets', () => {
  const result = importProgramScope('app.example.com', 'text', { assetBundles: ['retail'] });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.scope.allowedHosts).toEqual(['app.example.com']);
  expect(result.scope.assetHosts?.length).toBeGreaterThan(0);
  expect(result.scope.assetHosts?.every((host) => host.class === 'asset')).toBe(true);
  expect(new Set(result.scope.assetHosts?.map((host) => host.category))).toEqual(
    new Set(['consent', 'captcha', 'asset'])
  );
  expect(result.warnings.join(' ')).toContain('not testing authorization');
});
it('never uses a bundle to restore an excluded host or overlap a program subtree', () => {
  const result = importProgramScope('hcaptcha.com\n- cdn.cookielaw.org', 'text', {
    assetBundles: ['retail'],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(
    result.scope.assetHosts?.some(
      (a) => a.host === '.hcaptcha.com' || a.host === 'cdn.cookielaw.org'
    )
  ).toBe(false);
});
it('preserves excluded paths on asset hosts and refuses unknown bundles', () => {
  const result = importProgramScope(
    'app.example.com\n- https://cdn.cookielaw.org/private',
    'text',
    { assetBundles: ['consent'] }
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.scope.excludePaths).toContainEqual({
    hostSuffix: 'cdn.cookielaw.org',
    prefix: '/private',
  });
  expect(() => importProgramScope('app.test', 'text', { assetBundles: ['unknown'] })).toThrow();
});
