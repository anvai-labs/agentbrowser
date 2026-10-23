import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PRIVATE_PATH_ENV,
  type RunWindowsWriter,
  WINDOWS_WRITER_SCRIPT,
  writePrivateFile,
} from './private-file.js';

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

describe('private files on Windows (created atomically with an owner-only DACL)', () => {
  const windowsEnv = { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows' };

  function fakeWriter(result: { code: number; stderr: string } = { code: 0, stderr: '' }) {
    const calls: Parameters<RunWindowsWriter>[0][] = [];
    const run: RunWindowsWriter = async (request) => {
      calls.push(request);
      return result;
    };
    return { run, calls };
  }

  it('runs the fixed script through System32 PowerShell; path by env, secret by stdin only', async () => {
    const { run, calls } = fakeWriter();
    const result = await writePrivateFile('rel\\cookies.json', 'cookie-secret\n', {
      platform: 'win32',
      env: windowsEnv,
      runWindowsWriter: run,
    });
    expect(result.bytes).toBe(14);
    const call = calls[0];
    expect(call?.command).toBe(
      join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    );
    expect(call?.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_WRITER_SCRIPT,
    ]);
    expect(call?.env[PRIVATE_PATH_ENV]).toBe(resolve('rel\\cookies.json'));
    expect(call?.input.toString('utf8')).toBe('cookie-secret\n');
    // The secret never reaches argv or the environment.
    expect(JSON.stringify([call?.args, call?.env])).not.toContain('cookie-secret');
  });

  it('the script creates exclusively with a protected, single-ACE DACL for the current user', () => {
    expect(WINDOWS_WRITER_SCRIPT).toContain('[System.IO.FileMode]::CreateNew');
    expect(WINDOWS_WRITER_SCRIPT).toContain('SetAccessRuleProtection($true, $false)');
    expect(WINDOWS_WRITER_SCRIPT).toContain('WindowsIdentity]::GetCurrent().User');
    expect(WINDOWS_WRITER_SCRIPT).toContain('[System.IO.FileShare]::None');
    expect(WINDOWS_WRITER_SCRIPT.match(/AddAccessRule/g)).toHaveLength(1);
    expect(WINDOWS_WRITER_SCRIPT).not.toMatch(/\$\{|`\$/); // a constant: nothing interpolated
  });

  it('maps writer failures to typed stages', async () => {
    for (const [stderr, stage, code] of [
      ['create:EEXIST', 'create', 'EEXIST'],
      ['create:ENOENT', 'create', 'ENOENT'],
      ['write:EIO', 'write', 'EIO'],
      ['', 'create', 'EUNKNOWN'],
    ] as const) {
      const { run } = fakeWriter({ code: stderr.startsWith('write') ? 4 : 3, stderr });
      await expect(
        writePrivateFile('C:\\x\\c.json', 'x', {
          platform: 'win32',
          env: windowsEnv,
          runWindowsWriter: run,
        })
      ).rejects.toMatchObject({ name: 'PrivateFileError', stage, code });
    }
  });

  it('fails as a create error when PowerShell cannot be started', async () => {
    const run: RunWindowsWriter = async () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    };
    await expect(
      writePrivateFile('C:\\x\\c.json', 'x', {
        platform: 'win32',
        env: windowsEnv,
        runWindowsWriter: run,
      })
    ).rejects.toMatchObject({ stage: 'create', code: 'ESPAWN' });
  });
});
