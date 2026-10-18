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
    });
  });

  it('maps *.host to subdomains only and says the apex is out unless listed', () => {
    const result = importProgramScope('*.only.test\n', 'text');
    expect(result.ok && result.scope.allowedHosts).toEqual(['.only.test']);
    expect(result.report[0]?.note).toMatch(/apex only\.test is not in scope/);
  });

  it('sets allowedSchemes only when every in-scope entry names the same schemes', () => {
    const https = importProgramScope('https://a.test\nhttps://b.test/x\n', 'text');
    expect(https.ok && https.scope.allowedSchemes).toEqual(['https']);
    const mixed = importProgramScope('https://a.test\nb.test\n', 'text');
    expect(mixed.ok && 'allowedSchemes' in mixed.scope).toBe(false);
  });

  it.each([
    ['a public-suffix wildcard', '*.com'],
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
