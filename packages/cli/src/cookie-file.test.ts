import * as fsPromises from 'node:fs/promises';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CliClient, buildCli } from './cli.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return { ...actual, open: vi.fn(actual.open) };
});

const cookie = { name: 'sid', value: 'PRIVATE-COOKIE', domain: 'example.com', path: '/' };
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cookie-cli-test-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const create = vi.fn().mockResolvedValue({ sessionId: 'ses_1' });
  const cookies = vi.fn().mockResolvedValue([cookie]);
  const cli = buildCli({
    createClient: () => ({ sessions: { create, cookies } }) as unknown as CliClient,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { out, err, create, cookies, cli, run: (...args: string[]) => cli.run(args) };
}
async function source(text: string | Buffer) {
  const path = join(dir, 'input');
  await writeFile(path, text);
  return path;
}
async function importFile(text: string | Buffer, ...flags: string[]) {
  const h = harness();
  const file = await source(text);
  const code = await h.run(
    '--json',
    'session',
    'create',
    '--tenant',
    't',
    '--cookies-file',
    file,
    ...flags
  );
  return { ...h, code };
}
describe('cookie-file credential handoff', () => {
  it('imports canonical SDK cookie JSON without echoing credentials', async () => {
    const h = await importFile(JSON.stringify([cookie]));
    expect(h.code).toBe(0);
    expect(h.create).toHaveBeenCalledWith({ tenantId: 't', cookies: [cookie] });
    expect([...h.out, ...h.err].join()).not.toContain(cookie.value);
  });
  it('supports Netscape HttpOnly, empty values and exact domain semantics', async () => {
    const h = await importFile(
      '# Netscape HTTP Cookie File\n#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsid\t\n',
      '--cookies-format',
      'netscape'
    );
    expect(h.code).toBe(0);
    expect(h.create.mock.calls[0]?.[0].cookies).toEqual([
      {
        name: 'sid',
        value: '',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        expires: -1,
      },
    ]);
  });
  it('supports explicit 12-column DevTools TSV with security attributes', async () => {
    const row = [
      'sid',
      'PRIVATE-COOKIE',
      'example.com',
      '/',
      'Session',
      '20',
      '✓',
      '✓',
      'None',
      '',
      '',
      'Medium',
    ].join('\t');
    const h = await importFile(row, '--cookies-format', 'chrome-devtools-tsv');
    expect(h.code).toBe(0);
    expect(h.create.mock.calls[0]?.[0].cookies).toEqual([
      { ...cookie, expires: -1, httpOnly: true, secure: true, sameSite: 'None' },
    ]);
  });
  it.each([
    ['not PRIVATE-COOKIE JSON', []],
    [JSON.stringify([{ ...cookie, expires: 0 }]), []],
    [JSON.stringify([{ ...cookie, partitionKey: 'PRIVATE-COOKIE' }]), []],
    [JSON.stringify([{ ...cookie, unknownSecurity: true }]), []],
    [JSON.stringify([cookie, cookie]), []],
    [JSON.stringify([cookie, { ...cookie, domain: '.example.com' }]), []],
    [JSON.stringify([{ ...cookie, name: '__Host-sid', secure: true, domain: '.example.com' }]), []],
    [JSON.stringify([{ ...cookie, name: '__Secure-sid' }]), []],
    [JSON.stringify([{ ...cookie, sameSite: 'None' }]), []],
    ['example.com\tTRUE\t/\tFALSE\t0\tsid\tPRIVATE-COOKIE', ['--cookies-format', 'netscape']],
    ['example.com\tFALSE\t/\tFALSE\tNaN\tsid\tPRIVATE-COOKIE', ['--cookies-format', 'netscape']],
    [JSON.stringify(Array.from({ length: 1001 }, (_, i) => ({ ...cookie, name: `c${i}` }))), []],
    [JSON.stringify([{ ...cookie, value: 'x'.repeat(1024 * 1024) }]), []],
    [Buffer.from([0xff]), []],
  ])(
    'refuses invalid input before session creation without payload leakage (%#)',
    async (text, flags) => {
      const h = await importFile(text, ...flags);
      expect(h.code).toBe(1);
      expect(h.create).not.toHaveBeenCalled();
      expect(h.out).toEqual([]);
      expect(h.err.join()).not.toContain('PRIVATE-COOKIE');
    }
  );
  it('refuses partition records unless explicitly omitted, with counts only', async () => {
    const row = [
      'sid',
      'PRIVATE-COOKIE',
      'example.com',
      '/',
      'Session',
      '20',
      '',
      '✓',
      'None',
      'https://example.com',
      '✓',
      'Medium',
    ].join('\t');
    const denied = await importFile(row, '--cookies-format', 'chrome-devtools-tsv');
    expect(denied.code).toBe(1);
    expect(denied.create).not.toHaveBeenCalled();
    const h = await importFile(
      row,
      '--cookies-format',
      'chrome-devtools-tsv',
      '--cookies-skip-unsupported'
    );
    expect(h.code).toBe(0);
    expect(h.create.mock.calls[0]?.[0].cookies).toEqual([]);
    expect(h.err.join()).toContain('1');
    expect(h.err.join()).not.toContain(cookie.value);
  });
  it('rejects mutually exclusive sources and orphan parser policy flags', async () => {
    for (const flags of [
      ['--cookies-format', 'json'],
      ['--cookies-skip-unsupported'],
      ['--cookies', '[]', '--cookies-file', await source('[]')],
    ]) {
      const h = harness();
      expect(await h.run('session', 'create', '--tenant', 't', ...flags)).toBe(1);
      expect(h.create).not.toHaveBeenCalled();
    }
  });
  it('refuses nonexistent, directory and symlink input without reflecting paths', async () => {
    const file = await source('[]');
    const link = join(dir, 'link');
    await symlink(file, link);
    for (const path of [join(dir, 'PRIVATE-COOKIE'), dir, link]) {
      const h = harness();
      expect(await h.run('session', 'create', '--tenant', 't', '--cookies-file', path)).toBe(1);
      expect(h.create).not.toHaveBeenCalled();
      expect(h.err.join()).not.toContain('PRIVATE-COOKIE');
    }
  });
  it('exports exclusively with owner-only permissions and reimports JSON', async () => {
    const h = harness();
    const file = join(dir, 'output.json');
    expect(await h.run('--json', 'session', 'cookies', 'ses_1', '--output', file)).toBe(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([cookie]);
    expect(h.out.join()).not.toContain(cookie.value);
    expect(JSON.parse(h.out.join())).toEqual({ count: 1, path: file });
    const seeded = await importFile(await readFile(file));
    expect(seeded.code).toBe(0);
    const h2 = harness();
    expect(await h2.run('session', 'cookies', 'ses_1', '--output', file)).toBe(1);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([cookie]);
  });
  it('does not create partial files or reveal malformed service responses', async () => {
    const h = harness();
    h.cookies.mockResolvedValue([{ ...cookie, partitionKey: 'PRIVATE-COOKIE' }]);
    const file = join(dir, 'output');
    expect(await h.run('session', 'cookies', 'ses_1', '--output', file)).toBe(1);
    await expect(stat(file)).rejects.toThrow();
    expect([...h.out, ...h.err].join()).not.toContain(cookie.value);
  });
  it('does not use partition omission to conceal malformed cookies', async () => {
    const h = await importFile(
      JSON.stringify([{ ...cookie, expires: 0, partitionKey: 'https://example.com' }]),
      '--cookies-skip-unsupported'
    );
    expect(h.code).toBe(1);
    expect(h.create).not.toHaveBeenCalled();
    for (const invalid of [{ name: '' }, { value: 42 }, { domain: 'https://example.com' }]) {
      const bad = await importFile(
        JSON.stringify([{ ...cookie, ...invalid, partitionKey: 'https://example.com' }]),
        '--cookies-skip-unsupported'
      );
      expect(bad.code).toBe(1);
      expect(bad.create).not.toHaveBeenCalled();
    }
  });
  it('bounds normalized JSON expansion before session creation', async () => {
    const row = [
      'sid',
      '"'.repeat(550000),
      'example.com',
      '/',
      'Session',
      '550000',
      '',
      '',
      '',
      '',
      '',
      'Medium',
    ].join('\t');
    const h = await importFile(row, '--cookies-format', 'chrome-devtools-tsv');
    expect(h.code).toBe(1);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.err.join()).toContain('1048576');
  });
  it('refuses malformed timestamps, flags, header rows and extra columns', async () => {
    const row = [
      'sid',
      'PRIVATE-COOKIE',
      'example.com',
      '/',
      'Session',
      '20',
      '',
      '✓',
      'None',
      '',
      '',
      'Medium',
    ];
    for (const [index, value] of [
      [4, '2027-02-30T00:00:00Z'],
      [6, 'true'],
      [8, 'Whatever'],
      [10, 'unknown'],
      [11, 'Urgent'],
    ] as const) {
      const fields = [...row];
      fields[index] = value;
      const h = await importFile(fields.join('\t'), '--cookies-format', 'chrome-devtools-tsv');
      expect(h.code).toBe(1);
      expect(h.create).not.toHaveBeenCalled();
      expect(h.err.join()).not.toContain(cookie.value);
    }
    const h = await importFile(
      [...row, 'extra'].join('\t'),
      '--cookies-format',
      'chrome-devtools-tsv'
    );
    expect(h.code).toBe(1);
  });
  it('preserves future ISO timestamps, unicode values and session expiry on roundtrip', async () => {
    const row = [
      'sid',
      'é',
      'example.com',
      '/',
      '2099-01-01T00:00:00.000Z',
      '2',
      '',
      '✓',
      'Lax',
      '',
      '',
      'High',
    ].join('\t');
    const h = await importFile(row, '--cookies-format', 'chrome-devtools-tsv');
    expect(h.code).toBe(0);
    expect(h.create.mock.calls[0]?.[0].cookies[0]).toMatchObject({
      value: 'é',
      expires: 4070908800,
      sameSite: 'Lax',
    });
  });
  it('never reflects service errors for file import or export', async () => {
    const h = harness();
    h.create.mockRejectedValue(new Error(cookie.value));
    h.cookies.mockRejectedValue(new Error(cookie.value));
    expect(
      await h.run(
        'session',
        'create',
        '--tenant',
        't',
        '--cookies-file',
        await source(JSON.stringify([cookie]))
      )
    ).toBe(1);
    expect(await h.run('session', 'cookies', 'ses_1', '--output', join(dir, 'export'))).toBe(1);
    expect([...h.out, ...h.err].join()).not.toContain(cookie.value);
  });
  it('preserves symlink output targets and their existing contents', async () => {
    const file = await source('keep');
    const link = join(dir, 'output');
    await symlink(file, link);
    const h = harness();
    expect(await h.run('session', 'cookies', 'ses_1', '--output', link)).toBe(1);
    expect(await readFile(file, 'utf8')).toBe('keep');
  });
  it.each([false, true])(
    'retains failed output without unlinking a replacement (replaced=%s)',
    async (replace) => {
      const output = join(dir, 'failed-output');
      const originalOpen = (await vi.importActual<typeof fsPromises>('node:fs/promises')).open;
      vi.mocked(fsPromises.open).mockImplementationOnce(async (...args) => {
        const handle = await originalOpen(...args);
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
          await handle.write('partial-private-output');
          if (replace) {
            await fsPromises.unlink(output);
            await writeFile(output, 'replacement-must-survive');
          }
          throw new Error('PRIVATE-COOKIE write failure');
        });
        return handle;
      });
      const h = harness();
      expect(await h.run('--json', 'session', 'cookies', 'ses_1', '--output', output)).toBe(1);
      expect(await readFile(output, 'utf8')).toBe(
        replace ? 'replacement-must-survive' : 'partial-private-output'
      );
      if (!replace) expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect(h.out).toEqual([]);
      expect(h.err.join()).toContain('Could not write cookie output file');
      expect(h.err.join()).not.toContain('PRIVATE-COOKIE');
    }
  );
});
