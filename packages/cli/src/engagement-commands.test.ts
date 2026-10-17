// T10 M2: `engagement export` and the offline `engagement verify`.
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGAGEMENT_GENESIS, engagementChainHash } from '@agentbrowser/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCli, type CliClient } from './cli.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function ledger(records: Array<{ type: string; data: Record<string, unknown> }>): string {
  let prev = ENGAGEMENT_GENESIS;
  return records
    .map((record, seq) => {
      const at = '2026-10-17T00:00:00.000Z';
      const hash = engagementChainHash(prev, JSON.stringify({ seq, at, type: record.type, data: record.data }));
      const line = JSON.stringify({ seq, at, type: record.type, data: record.data, prev, hash });
      prev = hash;
      return line;
    })
    .join('\n')
    .concat('\n');
}
const sample = ledger([
  { type: 'engagement.opened', data: { engagementId: 'eng_x' } },
  { type: 'request', data: { url: 'https://a.example/' } },
  { type: 'engagement.closed', data: {} },
]);

async function run(argv: string[], client: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const cli = buildCli({
    createClient: () => client as unknown as CliClient,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  });
  return { code: await cli.run(argv), out, err };
}

describe('engagement commands (T10 M2)', () => {
  it('verify accepts an intact ledger and rejects an edited one, offline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-eng-'));
    dirs.push(dir);
    const good = join(dir, 'good.jsonl');
    const bad = join(dir, 'bad.jsonl');
    await writeFile(good, sample);
    await writeFile(bad, sample.replace('a.example', 'b.example'));
    const ok = await run(['engagement', 'verify', good]);
    expect(ok.code).toBe(0);
    expect(ok.out.join('\n')).toContain('chain verifies: 3 records, closed');
    const broken = await run(['--json', 'engagement', 'verify', bad]);
    expect(broken.code).toBe(1);
    expect(JSON.parse(broken.out.join('\n'))).toMatchObject({ ok: false, seq: 1 });
  });

  it('export writes a private file and verifies it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-eng-'));
    dirs.push(dir);
    const file = join(dir, 'out.jsonl');
    const exportLedger = vi.fn().mockResolvedValue(sample);
    const result = await run(['engagement', 'export', 'eng_x', '--out', file], {
      engagements: { export: exportLedger },
    });
    expect(result.code).toBe(0);
    expect(exportLedger).toHaveBeenCalledWith('eng_x');
    expect(await readFile(file, 'utf8')).toBe(sample);
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect(result.out.join('\n')).toContain('chain verifies');
    // Never overwrites.
    const again = await run(['engagement', 'export', 'eng_x', '--out', file], {
      engagements: { export: exportLedger },
    });
    expect(again.code).not.toBe(0);
  });
});
