// T10 M3: `scope import` converts a program scope offline (no server).
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCli, type CliClient } from './cli.js';

async function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const cli = buildCli({
    createClient: () => ({}) as unknown as CliClient,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  });
  const code = await cli.run(argv);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const dir = mkdtempSync(join(tmpdir(), 'scope-import-'));
const file = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

describe('scope import (T10 M3)', () => {
  it('prints the decisions and the scope; --json carries scope and report', async () => {
    const input = file('a.txt', '*.corp.test\ncorp.test\n- vpn.corp.test\n10.0.0.0/8\n');
    const human = await run(['scope', 'import', input, '--from', 'text']);
    expect(human.code).toBe(0);
    expect(human.out).toContain('in       *.corp.test -> .corp.test');
    expect(human.out).toContain('out      vpn.corp.test -> vpn.corp.test');
    expect(human.out).toContain('refused  10.0.0.0/8 (a CIDR range is not expressible)');
    expect(human.out).toContain('1 in-scope entry refused: the scope is narrower than the program');
    const json = await run(['--json', 'scope', 'import', input, '--from', 'text']);
    const parsed = JSON.parse(json.out);
    expect(parsed.ok).toBe(true);
    expect(parsed.scope.allowedHosts).toEqual(['.corp.test', 'corp.test']);
    expect(parsed.scope.excludeHosts).toEqual(['vpn.corp.test']);
  });

  it('exits 1 and writes nothing when an exclusion cannot be expressed', async () => {
    const input = file('b.txt', '*.corp.test\n- 10.0.0.0/8\n');
    const out = join(dir, 'b.json');
    const result = await run(['scope', 'import', input, '--from', 'text', '--out', out]);
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
    expect((await run(args)).code).toBe(0);
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
    expect((await run(args)).code).not.toBe(0);
  });

  it('refuses a bad --from, half an authorization, and malformed input', async () => {
    const input = file('d.txt', 'app.test\n');
    expect((await run(['scope', 'import', input, '--from', 'yaml'])).code).not.toBe(0);
    const half = await run([
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
    expect((await run(['scope', 'import', bad, '--from', 'h1'])).code).not.toBe(0);
  });
});
