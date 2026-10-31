import { expect, it } from 'vitest';
import { importProgramScope } from './program-scope-import.js';
import { parseScopeConfiguration, scopeIdentityHints } from './scope-configuration.js';

const scope = {
  allowedHosts: ['wolt.com'],
  requestHeaders: [{ header: 'X-HackerOne-Research', value: 'test', hostSuffix: 'wolt.com' }],
  identityBindings: [{ header: 'X-HackerOne-Research', value: 'test', allowedHosts: ['wolt.com'] }],
  allowedMethods: ['GET', 'POST'],
  requestBudget: 400,
};
it('round-trips canonical configuration without losing markers, bindings or restrictions', () => {
  const parsed = parseScopeConfiguration(JSON.stringify(scope));
  expect(parsed).toEqual(scope);
  expect(importProgramScope(JSON.stringify(parsed), 'agentbrowser')).toMatchObject({
    ok: true,
    scope,
  });
  expect(() =>
    importProgramScope(JSON.stringify(scope), 'agentbrowser', { requestBudget: 900 })
  ).toThrow('overrides');
});
it('refuses unknown fields and unsafe header injection rather than dropping them', () => {
  for (const input of [
    { ...scope, unknownRestriction: true },
    { ...scope, requestHeaders: [{ header: 'Cookie', value: 'private' }] },
    { ...scope, requestHeaders: [{ ...scope.requestHeaders[0], typo: 'bad' }] },
  ])
    expect(() => parseScopeConfiguration(JSON.stringify(input))).toThrow();
});
it('warns only about bindings without matching injection and never includes values', () => {
  const hint = scopeIdentityHints({ identityBindings: scope.identityBindings });
  expect(hint.join(' ')).toContain('validates');
  expect(hint.join(' ')).toContain('does not inject');
  expect(hint.join(' ')).not.toContain('test');
  expect(scopeIdentityHints(scope)).toEqual([]);
  expect(scopeIdentityHints({})).toEqual([]);
});
