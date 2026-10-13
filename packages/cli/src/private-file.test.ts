import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePrivateFile } from './private-file.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'private-file-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.runIf(process.platform !== 'win32')('private files on POSIX', () => {
  it('creates an owner-only file exclusively and writes the text', async () => {
    const path = join(dir, 'secret.json');
    await writePrivateFile(path, 'secret\n');
    expect(await readFile(path, 'utf8')).toBe('secret\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('never overwrites an existing file or follows a symlink', async () => {
    const existing = join(dir, 'existing');
    await writeFile(existing, 'keep');
    await expect(writePrivateFile(existing, 'x')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(existing, 'utf8')).toBe('keep');
    const link = join(dir, 'link');
    await symlink(existing, link);
    await expect(writePrivateFile(link, 'x')).rejects.toBeDefined();
    expect(await readFile(existing, 'utf8')).toBe('keep');
  });
});

describe('private files on Windows (owner-only ACL before any secret is written)', () => {
  const sid = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  const windowsEnv = { SystemRoot: 'C:\\Windows' };

  function fakeRunner(fail?: 'whoami' | 'icacls') {
    const calls: { command: string; args: string[]; sizeAtCall: number }[] = [];
    const run = async (command: string, args: string[]) => {
      const target = args[0] ?? '';
      const sizeAtCall = command.endsWith('icacls.exe') ? (await stat(target)).size : -1;
      calls.push({ command, args, sizeAtCall });
      if (fail && command.toLowerCase().includes(fail)) throw new Error(`${fail} failed`);
      return command.endsWith('whoami.exe') ? `"desktop\\\\user","${sid}"\r\n` : 'processed file';
    };
    return { run, calls };
  }

  it('restricts the new, still-empty file to the current user, then writes', async () => {
    const path = join(dir, 'cookies.json');
    const { run, calls } = fakeRunner();
    await writePrivateFile(path, 'secret\n', { platform: 'win32', env: windowsEnv, run });
    expect(calls.map((c) => c.command)).toEqual([
      join('C:\\Windows', 'System32', 'whoami.exe'),
      join('C:\\Windows', 'System32', 'icacls.exe'),
    ]);
    const icacls = calls[1];
    expect(icacls?.args).toEqual([path, '/inheritance:r', '/grant:r', `*${sid}:F`]);
    expect(icacls?.sizeAtCall).toBe(0); // nothing secret on disk before the ACL is in place
    expect(await readFile(path, 'utf8')).toBe('secret\n');
  });

  it('fails closed and removes the empty file when the ACL cannot be applied', async () => {
    for (const failing of ['whoami', 'icacls'] as const) {
      const path = join(dir, `cookies-${failing}.json`);
      const { run } = fakeRunner(failing);
      await expect(
        writePrivateFile(path, 'secret\n', { platform: 'win32', env: windowsEnv, run })
      ).rejects.toThrow(/owner-only/);
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('rejects an unparseable SID instead of granting to a guessed principal', async () => {
    const path = join(dir, 'cookies.json');
    const run = async (command: string) => (command.endsWith('whoami.exe') ? 'garbage' : '');
    await expect(
      writePrivateFile(path, 'x', { platform: 'win32', env: windowsEnv, run })
    ).rejects.toThrow(/owner-only/);
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
