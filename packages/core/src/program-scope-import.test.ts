// T10 M3: converting a published program scope into an EngagementScope.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateEngagementScope } from '@agentbrowser/protocol';
import { describe, expect, it } from 'vitest';
import { importProgramScope } from './program-scope-import.js';

const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', 'program-scope', name), 'utf8');

describe('importProgramScope (T10 M3)', () => {
  it('HackerOne structured scopes: wildcard, apex, URL path, exclusions; inexpressible entries refused', () => {
    const result = importProgramScope(fixture('h1.json'), 'h1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope).toEqual({
      allowedHosts: ['.acme.test', 'acme.test', 'api.partner.test'],
      pathRules: [{ hostSuffix: 'api.partner.test', prefix: '/v2' }],
      excludeHosts: ['admin.acme.test'],
      excludePaths: [{ hostSuffix: 'www.acme.test', prefix: '/logout' }],
      allowedSchemes: ['http', 'https'],
      allowedPorts: [80, 443],
    });
    const refused = result.report.filter((entry) => entry.decision === 'refused');
    expect(refused.map((entry) => entry.entry)).toEqual([
      '10.0.0.0/8',
      'test.acme.app',
      'staging.*.acme.test',
    ]);
    expect(validateEngagementScope(result.scope).ok).toBe(true);
  });

  it('Bugcrowd target groups: website and api targets; mobile refused; unrelated exclusions dropped', () => {
    const result = importProgramScope(fixture('bugcrowd.json'), 'bugcrowd');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope).toEqual({
      allowedHosts: ['shop.example.test', '.api.example.test'],
      excludePaths: [{ hostSuffix: 'shop.example.test', prefix: '/blog' }],
      allowedSchemes: ['http', 'https'],
      allowedPorts: [80, 443],
    });
    const byEntry = Object.fromEntries(result.report.map((entry) => [entry.entry, entry.decision]));
    expect(byEntry['https://apps.apple.com/app/id1']).toBe('refused');
    expect(byEntry['https://elsewhere.test']).toBe('ignored');
  });

  it('text: "-" marks out of scope; a path under a wildcard-covered host adds no path rule', () => {
    const result = importProgramScope(fixture('scope.txt'), 'text');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope).toEqual({
      allowedHosts: ['.corp.test', 'corp.test'],
      excludeHosts: ['vpn.corp.test'],
      excludePaths: [{ hostSuffix: 'portal.corp.test', prefix: '/app/admin' }],
      allowedSchemes: ['http', 'https'],
      allowedPorts: [80, 443],
    });
  });

  it('maps *.host to subdomains only and says the apex is out unless listed', () => {
    const result = importProgramScope('*.only.test\n', 'text');
    expect(result.ok && result.scope.allowedHosts).toEqual(['.only.test']);
    expect(result.report[0]?.note).toMatch(/apex only\.test is not in scope/);
  });

  it('keeps one shared scheme; mixed or unstated schemes narrow to http and https (noted)', () => {
    const https = importProgramScope('https://a.test\nhttps://b.test/x\n', 'text');
    expect(https.ok && https.scope.allowedSchemes).toEqual(['https']);
    const mixed = importProgramScope('https://a.test\nhttp://b.test\n', 'text');
    expect(mixed.ok && mixed.scope.allowedSchemes).toEqual(['http', 'https']);
    expect(mixed.report[0]?.note).toMatch(/schemes are scope-wide/);
    const unstated = importProgramScope('a.test\n', 'text');
    expect(unstated.ok && unstated.scope.allowedSchemes).toEqual(['http', 'https']);
    expect(https.ok && https.scope.allowedPorts).toEqual([443]);
    expect(unstated.ok && unstated.scope.allowedPorts).toEqual([80, 443]);
  });

  it('an encoded "*" in an exclusion path is a glob, not a literal', () => {
    expect(importProgramScope('app.test\n- app.test/admin/%2A\n', 'text')).toMatchObject({
      ok: true,
      scope: { excludePaths: [{ hostSuffix: 'app.test', prefix: '/admin' }] },
    });
    expect(importProgramScope('app.test\n- app.test/admin%2a\n', 'text').ok).toBe(false);
  });

  it('maps a trailing "/*" to its prefix; other path wildcards are inexpressible', () => {
    const glob = importProgramScope(
      'app.test\n- https://app.test/admin/*\nhttps://api.test/v1/*\n',
      'text'
    );
    expect(glob.ok).toBe(true);
    if (!glob.ok) return;
    expect(glob.scope.excludePaths).toEqual([{ hostSuffix: 'app.test', prefix: '/admin' }]);
    expect(glob.scope.pathRules).toEqual([{ hostSuffix: 'api.test', prefix: '/v1' }]);
    // An exclusion that cannot be expressed fails the import rather than excluding nothing.
    for (const line of ['- app.test/admin*', '- app.test/a/*/b'])
      expect(importProgramScope(`app.test\n${line}\n`, 'text').ok, line).toBe(false);
    const inScope = importProgramScope('ok.test\napp.test/api*\n', 'text');
    expect(inScope.ok && inScope.report[1]?.decision).toBe('refused');
  });

  it('a broader exclusion over a narrower wildcard is kept, not dropped', () => {
    const result = importProgramScope('*.app.example.test\n- *.example.test\n', 'text');
    expect(result.ok && result.scope.excludeHosts).toEqual(['.example.test']);
  });

  it('an apex path entry is not "covered" by its own subdomain wildcard', () => {
    const result = importProgramScope('*.example.test\nexample.test/api\n', 'text');
    expect(result.ok && result.scope.allowedHosts).toEqual(['.example.test', 'example.test']);
    expect(result.ok && result.scope.pathRules).toEqual([
      { hostSuffix: 'example.test', prefix: '/api' },
    ]);
  });

  it('notes when a suffix path rule also restricts a host listed in full', () => {
    const result = importProgramScope('*.example.test/api\nwww.example.test\n', 'text');
    expect(result.report[0]?.note).toMatch(/also restricts www\.example\.test/);
  });

  it('trailing slashes, "//" and "!" are handled', () => {
    const result = importProgramScope(
      'https://a.test/x/\nhttps://b.test//\n! https://a.test/x/y\n',
      'text'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope.allowedHosts).toEqual(['a.test', 'b.test']);
    expect(result.scope.pathRules).toEqual([{ hostSuffix: 'a.test', prefix: '/x' }]);
    expect(result.scope.excludePaths).toEqual([{ hostSuffix: 'a.test', prefix: '/x/y' }]);
  });

  it('HackerOne: a missing eligible_for_submission is out of scope', () => {
    const json = JSON.stringify({
      data: [
        {
          attributes: {
            asset_type: 'URL',
            asset_identifier: 'in.test',
            eligible_for_submission: true,
          },
        },
        { attributes: { asset_type: 'URL', asset_identifier: 'maybe.test' } },
      ],
    });
    const result = importProgramScope(json, 'h1');
    expect(result.ok && result.scope.allowedHosts).toEqual(['in.test']);
  });

  it.each([
    ['a public-suffix wildcard', '*.com'],
    ['a multi-label public suffix', '*.co.uk'],
    ['a private-suffix wildcard', '*.github.io'],
    ['an unbracketed IPv6 literal', '2001:db8::1'],
    ['a mid-label wildcard', 'api.*.test'],
    ['a partial wildcard', '*api.test'],
    ['a non-default port', 'https://a.test:8443'],
    ['a non-web scheme', 'ftp://a.test'],
    ['a CIDR range', '192.0.2.0/24'],
    ['a Unicode host', 'bücher.test'],
  ])('refuses %s in scope (the scope only gets narrower)', (_what, line) => {
    const result = importProgramScope(`ok.test\n${line}\n`, 'text');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.find((entry) => entry.entry === line)?.decision).toBe('refused');
    expect(result.scope.allowedHosts).toEqual(['ok.test']);
  });

  it.each([
    ['a CIDR exclusion', '- 10.0.0.0/8'],
    ['a mid-label wildcard exclusion', '- internal.*.corp.test'],
    ['an exclusion with a port', '- https://corp.test:8443/admin'],
  ])('fails the whole import on %s it cannot express (the scope would be wider)', (_what, line) => {
    const result = importProgramScope(`*.corp.test\ncorp.test\n${line}\n`, 'text');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/exclusion .* cannot be expressed/);
  });

  it('fails when nothing in scope is expressible', () => {
    const result = importProgramScope('10.0.0.0/8\n', 'text');
    expect(result.ok).toBe(false);
  });

  it('records program metadata only as given; authorization needs both who and when', () => {
    const meta = {
      programId: 'acme',
      programVersion: '2026-10-01',
      authorizedBy: 'researcher@example.test',
      authorizedAt: '2026-10-17T00:00:00Z',
    };
    const result = importProgramScope('a.test\n', 'text', meta);
    expect(result.ok && result.scope.program).toEqual({
      id: 'acme',
      version: '2026-10-01',
      authorizedBy: 'researcher@example.test',
      authorizedAt: '2026-10-17T00:00:00Z',
    });
    const none = importProgramScope('a.test\n', 'text');
    expect(none.ok && 'program' in none.scope).toBe(false);
    expect(() =>
      importProgramScope('a.test\n', 'text', { programId: 'acme', authorizedBy: 'r' })
    ).toThrow(/authorizedBy and authorizedAt/);
  });

  it('rejects malformed input files', () => {
    expect(() => importProgramScope('{not json', 'h1')).toThrow(/HackerOne/);
    expect(() => importProgramScope('{"target_groups": 3}', 'bugcrowd')).toThrow(/Bugcrowd/);
  });
});

// T10 M5: sizing is explicit, warnings do not change the imported host rules.
it('sizes subrequests, warns below 150 and leaves an absent budget unbounded', () => {
  const small = importProgramScope('app.test', 'text', { requestBudget: 80 });
  expect(small).toMatchObject({
    ok: true,
    scope: { requestBudget: 80 },
    warnings: [expect.stringContaining('every subrequest and redirect hop')],
  });
  expect(importProgramScope('app.test', 'text', { requestBudget: 150 })).toMatchObject({
    ok: true,
    warnings: [],
  });
  expect(
    importProgramScope('app.test', 'text', {
      pagesPlanned: 4,
      rateLimit: { requests: 5, perSeconds: 1 },
    })
  ).toMatchObject({
    ok: true,
    scope: { requestBudget: 480, rateLimit: { requests: 5, perSeconds: 1 } },
    warnings: [],
  });
  expect(importProgramScope('app.test', 'text', { pagesPlanned: 1 })).toMatchObject({
    ok: true,
    scope: { requestBudget: 150 },
  });
  const absent = importProgramScope('app.test', 'text');
  expect(absent.ok && absent.scope).not.toHaveProperty('requestBudget');
  expect(() =>
    importProgramScope('app.test', 'text', { pagesPlanned: 1, requestBudget: 80 })
  ).toThrow(/not both/);
  expect(
    importProgramScope('app.test', 'text', { rateLimit: { requests: 0, perSeconds: 1 } }).ok
  ).toBe(false);
});

it('explicit SPA presets size subrequests and never exceed a supplied published cap', () => {
  const preset = importProgramScope('app.test', 'text', { preset: 'h1-spa' });
  expect(preset.ok && preset.scope).toMatchObject({
    requestBudget: 900,
    rateLimit: { requests: 5, perSeconds: 1 },
  });
  const lower = importProgramScope('app.test', 'text', {
    preset: 'h1-spa',
    rateLimit: { requests: 1, perSeconds: 2 },
  });
  expect(lower.ok && lower.scope.rateLimit).toEqual({ requests: 1, perSeconds: 2 });
  const higher = importProgramScope('app.test', 'text', {
    preset: 'h1-spa',
    rateLimit: { requests: 10, perSeconds: 1 },
  });
  expect(higher.ok && higher.scope.rateLimit).toEqual({ requests: 5, perSeconds: 1 });
  expect(() => importProgramScope('app.test', 'text', { preset: 'unknown' as never })).toThrow(
    'Unknown scope preset'
  );
});
