import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readApiKeyFile } from './api-key-file.js';
import { buildCli, type CliClient } from './cli.js';

it.skipIf(process.platform === 'win32')(
  'loads a separate API credential privately; explicit file overrides the environment',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-key-'));
    vi.stubEnv('AGENTBROWSER_API_KEY', 'synthetic-env');
    try {
      const file = join(dir, 'credential');
      writeFileSync(file, 'synthetic-file-credential\n', { mode: 0o600 });
      const out: string[] = [];
      const client = vi.fn(
        () =>
          ({
            sessions: {
              get: vi.fn().mockRejectedValue(new Error('failure synthetic-file-credential')),
            },
          }) as unknown as CliClient
      );
      const cli = buildCli({
        out: (line) => out.push(line),
        err: (line) => out.push(line),
        createClient: client,
      });
      expect(await cli.run(['--api-key-file', file, 'session', 'get', 'ses_public'])).toBe(1);
      expect(client).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'synthetic-file-credential' })
      );
      expect(out.join('')).not.toContain('synthetic-file-credential');
      client.mockClear();
      expect(
        await cli.run([
          '--api-key-file',
          file,
          '--api-key',
          'synthetic-flag',
          'session',
          'get',
          'ses_public',
        ])
      ).toBe(1);
      expect(client).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform === 'win32')(
  'rejects symlinks, permissions, oversized, empty and multiline input without disclosing it',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-key-'));
    try {
      const file = join(dir, 'credential');
      for (const value of ['', 'private\nsecond-line', 'x'.repeat(4097)]) {
        writeFileSync(file, value, { mode: 0o600 });
        expect(() => readApiKeyFile(file)).toThrow('Cannot read API key file');
      }
      writeFileSync(file, 'private');
      chmodSync(file, 0o644);
      expect(() => readApiKeyFile(file)).toThrow('owner-only');
      chmodSync(file, 0o600);
      const link = join(dir, 'link');
      symlinkSync(file, link);
      expect(() => readApiKeyFile(link)).toThrow('regular file');
      expect(() => readApiKeyFile(dir)).toThrow('regular file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

it('refuses Windows key files instead of treating ignored mode bits as an ACL check', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    expect(() => readApiKeyFile('unused')).toThrow('POSIX owner checks');
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});
