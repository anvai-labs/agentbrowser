import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildCli, type CliClient } from './cli.js';
import { parseCookieText } from './cookie-file.js';

const cookie = {
  name: 'cf_clearance',
  value: 'PRIVATE-COOKIE-CANARY',
  domain: 'example.com',
  path: '/',
};
const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'seed-provenance-'));
  cleanup.push(dir);
  const out: string[] = [];
  const err: string[] = [];
  const create = vi.fn(async () => ({ sessionId: 'created' }));
  const cookies = vi.fn(async () => [cookie]);
  const cli = buildCli({
    createClient: () => ({ sessions: { create, cookies } }) as unknown as CliClient,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { dir, out, err, create, cookies, cli };
}
const envelope = {
  format: 'agentbrowser-cookie-seed/v1',
  cookies: [cookie],
  provenance: {
    source: 'operator-cdp',
    sourceContext: 'incognito',
    extractedAt: '2026-11-01T12:00:00.000Z',
    domainFilters: ['example.com'],
    cookieClasses: [],
  },
};

it('recomputes portability classes from imported cookie rows', () => {
  expect(parseCookieText(JSON.stringify(envelope)).provenance?.cookieClasses).toEqual([
    'fingerprint-bound',
    'session',
  ]);
});

it('exports a private timestamped seed and reimports only canonical cookie wire fields', async () => {
  const f = await fixture();
  const output = join(f.dir, 'seed.json');
  expect(
    await f.cli.run([
      '--json',
      'session',
      'cookies',
      'existing',
      '--output',
      output,
      '--with-provenance',
    ])
  ).toBe(0);
  const file = JSON.parse(await readFile(output, 'utf8'));
  expect(file.format).toBe('agentbrowser-cookie-seed/v1');
  expect(file.provenance).toMatchObject({
    source: 'agentbrowser-session',
    sourceContext: 'unknown',
    cookieClasses: ['fingerprint-bound', 'session'],
  });
  expect(Number.isFinite(Date.parse(file.provenance.extractedAt))).toBe(true);
  expect((await stat(output)).mode & 0o777).toBe(0o600);
  expect(f.out.join(' ')).not.toContain(cookie.value);
  expect(
    await f.cli.run(['--json', 'session', 'create', '--tenant', 'local', '--cookies-file', output]),
    f.err.join('\n')
  ).toBe(0);
  expect(f.create.mock.calls[0]?.[0]).toMatchObject({ cookies: [cookie] });
  expect(f.create.mock.calls[0]?.[0]).not.toHaveProperty('provenance');
  expect(f.create.mock.calls[0]?.[0]).not.toHaveProperty('cookieClasses');
});

it('requires a private output path before reading/exporting credentials', async () => {
  const f = await fixture();
  expect(await f.cli.run(['session', 'cookies', 'existing', '--with-provenance'])).not.toBe(0);
  expect(f.cookies).not.toHaveBeenCalled();
});

it('refuses unknown metadata without echoing it or submitting a session', async () => {
  const f = await fixture();
  const file = join(f.dir, 'bad.json');
  await writeFile(
    file,
    JSON.stringify({
      ...envelope,
      provenance: { ...envelope.provenance, unknown: 'PRIVATE-METADATA-CANARY' },
    })
  );
  expect(
    await f.cli.run(['session', 'create', '--tenant', 'local', '--cookies-file', file])
  ).not.toBe(0);
  expect(f.create).not.toHaveBeenCalled();
  expect(f.err.join(' ')).toContain('Invalid bounded cookie seed file');
  expect(f.err.join(' ')).not.toMatch(/PRIVATE-METADATA|PRIVATE-COOKIE/);
});

it('keeps whole-cookie partition refusal and explicit omission for versioned inputs', async () => {
  const f = await fixture();
  const file = join(f.dir, 'partition.json');
  await writeFile(
    file,
    JSON.stringify({ ...envelope, cookies: [{ ...cookie, partitionKey: 'https://example.com' }] })
  );
  expect(
    await f.cli.run(['session', 'create', '--tenant', 'local', '--cookies-file', file])
  ).not.toBe(0);
  expect(f.create).not.toHaveBeenCalled();
  expect(
    await f.cli.run([
      'session',
      'create',
      '--tenant',
      'local',
      '--cookies-file',
      file,
      '--cookies-skip-unsupported',
    ]),
    f.err.join('\n')
  ).toBe(0);
  expect(f.create.mock.calls[0]?.[0]).toMatchObject({ cookies: [] });
});
