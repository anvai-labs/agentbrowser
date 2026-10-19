// T10 M3: `finding check` and `finding sarif` against an exported ledger (offline), via the
// light @agentbrowser/engagement package.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGAGEMENT_GENESIS, engagementChainHash } from '@agentbrowser/core';
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

const dir = mkdtempSync(join(tmpdir(), 'findings-'));
const write = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

function ledgerText() {
  const records = [
    {
      type: 'engagement.opened',
      data: {
        engagementId: 'eng_bbbbbbbbbbbbbbbbbbbbbbbb',
        scope: {
          allowedHosts: ['app.test'],
          pathRules: [],
          identityBindings: [],
          expired: false,
          denials: {},
        },
      },
    },
    {
      type: 'request',
      data: { outcome: 'finished', method: 'GET', url: 'https://app.test/api/x', status: 200 },
    },
    { type: 'engagement.closed', data: { records: 2 } },
  ];
  let prev = ENGAGEMENT_GENESIS;
  return `${records
    .map((record, seq) => {
      const at = '2026-10-17T00:00:00.000Z';
      const body = JSON.stringify({ seq, at, type: record.type, data: record.data });
      const hash = engagementChainHash(prev, body);
      const line = JSON.stringify({ seq, at, type: record.type, data: record.data, prev, hash });
      prev = hash;
      return line;
    })
    .join('\n')}\n`;
}

const ledger = write('ledger.jsonl', ledgerText());
const finding = {
  id: 'F-1',
  title: 'Info leak',
  severity: 'medium',
  status: 'confirmed',
  url: 'https://app.test/api/x',
  description: 'Returns another tenant id.',
  ledgerRefs: [1],
  evidence: {
    method: 'independent-reproduction',
    reproducedAt: '2026-10-17T01:00:00Z',
    observation: 'Second account saw the first tenant id.',
    cleanup: { required: false, performed: false, note: 'read-only' },
  },
};

describe('finding commands (T10 M3)', () => {
  it('check accepts bound findings and refuses an out-of-scope one with exit 1', async () => {
    const good = write('good.json', JSON.stringify([finding]));
    const ok = await run(['finding', 'check', '--ledger', ledger, '--findings', good]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('1 finding(s) bound to eng_bbbbbbbbbbbbbbbbbbbbbbbb');
    const bad = write('bad.json', JSON.stringify([{ ...finding, url: 'https://evil.test/x' }]));
    const refused = await run(['finding', 'check', '--ledger', ledger, '--findings', bad]);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(
      /FINDINGS REFUSED[\s\S]*F-1: the URL is outside the engagement scope/
    );
  });

  it('sarif writes a manual-submission draft (0600, exclusive) and refuses unbound findings', async () => {
    const good = write('good2.json', JSON.stringify([finding]));
    const out = join(dir, 'report.sarif');
    const written = await run([
      'finding',
      'sarif',
      '--ledger',
      ledger,
      '--findings',
      good,
      '--out',
      out,
    ]);
    expect(written.code).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const sarif = JSON.parse(readFileSync(out, 'utf8'));
    expect(sarif.runs[0].properties).toMatchObject({ draft: true, submission: 'manual' });
    expect(sarif.runs[0].results[0].properties.ledgerRefs).toEqual([1]);
    expect(
      (await run(['finding', 'sarif', '--ledger', ledger, '--findings', good, '--out', out])).code
    ).not.toBe(0);
    const unbound = write('unbound.json', JSON.stringify([{ ...finding, ledgerRefs: [] }]));
    const none = join(dir, 'none.sarif');
    const refused = await run([
      'finding',
      'sarif',
      '--ledger',
      ledger,
      '--findings',
      unbound,
      '--out',
      none,
    ]);
    expect(refused.code).toBe(1);
    expect(() => statSync(none)).toThrow();
  });

  it('refuses a tampered ledger and a findings file that is not JSON', async () => {
    const tampered = write('tampered.jsonl', ledgerText().replace('/api/x', '/api/y'));
    const good = write('good3.json', JSON.stringify([finding]));
    const broken = await run(['finding', 'check', '--ledger', tampered, '--findings', good]);
    expect(broken.code).toBe(1);
    expect(broken.out).toMatch(/chain is broken/);
    const notJson = write('x.json', '{oops');
    expect(
      (await run(['finding', 'check', '--ledger', ledger, '--findings', notJson])).code
    ).not.toBe(0);
  });
});
