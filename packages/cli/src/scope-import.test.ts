// T10 M3: `scope import` converts a program scope offline (no server).
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from './test-support/cli-run.js';

const dir = mkdtempSync(join(tmpdir(), 'scope-import-'));
const file = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

describe('scope import (T10 M3)', () => {
  it('prints the decisions and the scope; --json carries scope and report', async () => {
    const input = file('a.txt', '*.corp.test\ncorp.test\n- vpn.corp.test\n10.0.0.0/8\n');
    const human = await runCli(['scope', 'import', input, '--from', 'text']);
    expect(human.code).toBe(0);
    expect(human.out).toContain('in       *.corp.test -> .corp.test');
    expect(human.out).toContain('out      vpn.corp.test -> vpn.corp.test');
    expect(human.out).toContain('refused  10.0.0.0/8 (a CIDR range is not expressible)');
    expect(human.out).toContain('1 in-scope entry refused: the scope is narrower than the program');
    const json = await runCli(['--json', 'scope', 'import', input, '--from', 'text']);
    const parsed = JSON.parse(json.out);
    expect(parsed.ok).toBe(true);
    expect(parsed.scope.allowedHosts).toEqual(['.corp.test', 'corp.test']);
    expect(parsed.scope.excludeHosts).toEqual(['vpn.corp.test']);
  });

  it('exits 1 and writes nothing when an exclusion cannot be expressed', async () => {
    const input = file('b.txt', '*.corp.test\n- 10.0.0.0/8\n');
    const out = join(dir, 'b.json');
    const result = await runCli(['scope', 'import', input, '--from', 'text', '--out', out]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/IMPORT REFUSED: exclusion 10\.0\.0\.0\/8 cannot be expressed/);
    expect(() => statSync(out)).toThrow();
  });

  it('--out writes the scope exclusively with mode 0600, with program authorization as given', async () => {
    const input = file('c.txt', 'app.test\n');
    const out = join(dir, 'c.json');
    const args = [
      'scope',
      'import',
      input,
      '--from',
      'text',
      '--out',
      out,
      '--program-id',
      'acme',
      '--authorized-by',
      'researcher@example.test',
      '--authorized-at',
      '2026-10-17T00:00:00Z',
    ];
    expect((await runCli(args)).code).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
      allowedHosts: ['app.test'],
      allowedSchemes: ['http', 'https'],
      allowedPorts: [80, 443],
      program: {
        id: 'acme',
        authorizedBy: 'researcher@example.test',
        authorizedAt: '2026-10-17T00:00:00Z',
      },
    });
    // Exclusive create: a second run never overwrites.
    expect((await runCli(args)).code).not.toBe(0);
  });

  it('refuses a bad --from, half an authorization, and malformed input', async () => {
    const input = file('d.txt', 'app.test\n');
    expect((await runCli(['scope', 'import', input, '--from', 'yaml'])).code).not.toBe(0);
    const half = await runCli([
      'scope',
      'import',
      input,
      '--from',
      'text',
      '--program-id',
      'p',
      '--authorized-by',
      'r',
    ]);
    expect(half.code).not.toBe(0);
    expect(half.err + half.out).toMatch(/authorizedBy and authorizedAt/);
    const bad = file('e.json', '{not json');
    expect((await runCli(['scope', 'import', bad, '--from', 'h1'])).code).not.toBe(0);
  });
});

it('imports an explicit bounty budget and reports low-budget warnings in human and JSON output', async () => {
  const input = file('sizing.txt', 'app.test');
  const argv = [
    'scope',
    'import',
    input,
    '--from',
    'text',
    '--request-budget',
    '80',
    '--rate-limit',
    '2/1',
  ];
  const human = await runCli(argv);
  expect(human.code).toBe(0);
  expect(human.out).toContain('WARNING: A single JS-heavy page');
  const json = JSON.parse((await runCli(['--json', ...argv])).out);
  expect(json.scope).toMatchObject({
    requestBudget: 80,
    rateLimit: { requests: 2, perSeconds: 1 },
  });
  expect(json.warnings).toHaveLength(1);
  expect((await runCli([...argv, '--pages-planned', '4'])).code).toBe(1);
  expect((await runCli([...argv, '--rate-limit', 'bogus'])).code).toBe(1);
});

it('imports explicit asset bundles without extending program targets or restoring excluded hosts', async () => {
  const input = file('bundle.txt', 'app.example.com\n- cdn.cookielaw.org\n');
  const result = await runCli([
    '--json',
    'scope',
    'import',
    input,
    '--from',
    'text',
    '--asset-bundle',
    'retail,sso',
  ]);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.out);
  expect(parsed.scope.allowedHosts).toEqual(['app.example.com']);
  expect(parsed.scope.assetHosts.every((entry: { class: string }) => entry.class === 'asset')).toBe(
    true
  );
  expect(
    parsed.scope.assetHosts.some((entry: { host: string }) => entry.host === 'cdn.cookielaw.org')
  ).toBe(false);
  expect(parsed.warnings.join(' ')).toContain('not testing authorization');
  expect(
    (await runCli(['scope', 'import', input, '--from', 'text', '--asset-bundle', 'unknown'])).code
  ).not.toBe(0);
});

it('exports and imports canonical scope configuration with markers and refuses unknown keys', async () => {
  const scope = {
    allowedHosts: ['wolt.com'],
    requestHeaders: [{ header: 'X-HackerOne-Research', value: 'test', hostSuffix: 'wolt.com' }],
    allowedMethods: ['GET', 'POST'],
    requestBudget: 400,
  };
  const input = file('canonical.json', JSON.stringify(scope));
  const exported = join(dir, 'canonical-export.json');
  expect((await runCli(['scope', 'export', input, '--out', exported])).code).toBe(0);
  expect(JSON.parse(readFileSync(exported, 'utf8'))).toEqual(scope);
  expect(statSync(exported).mode & 0o777).toBe(0o600);
  expect((await runCli(['scope', 'export', input, '--out', exported])).code).not.toBe(0);
  expect(JSON.parse(readFileSync(exported, 'utf8'))).toEqual(scope);
  const imported = await runCli(['--json', 'scope', 'import', exported, '--from', 'agentbrowser']);
  expect(imported.code).toBe(0);
  expect(JSON.parse(imported.out).scope).toEqual(scope);
  const invalid = file('canonical-invalid.json', JSON.stringify({ ...scope, typo: true }));
  expect((await runCli(['scope', 'export', invalid])).code).not.toBe(0);
  expect((await runCli(['scope', 'import', invalid, '--from', 'agentbrowser'])).code).not.toBe(0);
});
