import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCli, type CliClient } from './cli.js';

const bytes = Buffer.from('synthetic-private-payload');
const artifact = {
  artifactId: 'dl_1',
  type: 'download',
  contentType: 'application/octet-stream',
  sizeBytes: 999,
  url: 'https://private.invalid/?token=synthetic-secret',
  filename: 'private-filename',
  contentBase64: bytes.toString('base64'),
};
const commands = [
  ['download', 's', 'p', 'https://example.com/file'],
  ['download', 'collect', 's', 'p', 'dl_capture'],
];
const directories: string[] = [];
function outputPath() {
  const dir = mkdtempSync(join(tmpdir(), 'download-output-'));
  directories.push(dir);
  return join(dir, 'private-filename');
}
function fixture() {
  const out: string[] = [];
  const err: string[] = [];
  const sessions = {
    download: vi.fn().mockResolvedValue(artifact),
    collectDownload: vi.fn().mockResolvedValue(artifact),
    artifact: vi.fn().mockResolvedValue({ contentBase64: bytes.toString('base64') }),
  };
  const cli = buildCli({
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    createClient: () => ({ sessions }) as unknown as CliClient,
  });
  return { cli, out, err, sessions };
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.each(commands)('download receipt (%s %s)', (...command) => {
  it.each([false, true])('saves before emitting one compact receipt (json=%s)', async (json) => {
    const { cli, out, err, sessions } = fixture();
    const path = outputPath();
    expect(await cli.run([...(json ? ['--json'] : []), ...command, '--out', path])).toBe(0);
    expect(readFileSync(path)).toEqual(bytes);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    if (json) {
      expect(JSON.parse(out.join('\n'))).toEqual({
        artifactId: 'dl_1',
        type: 'download',
        contentType: 'application/octet-stream',
        sizeBytes: bytes.length,
        saved: path,
      });
    } else {
      expect(out).toEqual([`Saved dl_1 to ${path} (${bytes.length} bytes)`]);
    }
    expect(out.join('\n')).not.toMatch(/contentBase64|synthetic-secret|synthetic-private-payload/);
    expect(out.join('\n').length).toBeLessThan(1024);
    expect(sessions.artifact).toHaveBeenCalledExactlyOnceWith('s', 'dl_1');
  });

  it.each([false, true])('prints no success when saving fails (json=%s)', async (json) => {
    const { cli, out, err } = fixture();
    const path = outputPath();
    writeFileSync(path, 'keep existing file');
    expect(await cli.run([...(json ? ['--json'] : []), ...command, '--out', path])).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe('keep existing file');
    expect(out).toEqual([]);
    // A local write failure is a usage error naming the cause — never the
    // bounded server projection, which would read as a server fault.
    expect(err).toEqual([
      'Could not exclusively create download output file (EEXIST: path exists, parent missing, is a symlink, is not writable, or could not be made owner-only).',
    ]);
    expect(err.join('\n')).not.toContain(path);
  });

  it('retains a reference without fetching bytes when --out is absent', async () => {
    const { cli, out, sessions } = fixture();
    expect(await cli.run(['--json', ...command])).toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({
      artifactId: 'dl_1',
      type: 'download',
      contentType: 'application/octet-stream',
      sizeBytes: 999,
    });
    expect(sessions.artifact).not.toHaveBeenCalled();
  });

  it('saves a valid empty artifact', async () => {
    const { cli, out, sessions } = fixture();
    sessions.artifact.mockResolvedValue({ contentBase64: '' });
    const path = outputPath();
    expect(await cli.run(['--json', ...command, '--out', path])).toBe(0);
    expect(readFileSync(path)).toHaveLength(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ saved: path, sizeBytes: 0 });
  });

  it('uses supplied inline bytes without a second retrieval', async () => {
    const { cli, out, sessions } = fixture();
    const inlineArtifact = { ...artifact, inline: { contentBase64: bytes.toString('base64') } };
    sessions.download.mockResolvedValue(inlineArtifact);
    sessions.collectDownload.mockResolvedValue(inlineArtifact);
    const path = outputPath();
    expect(await cli.run(['--json', ...command, '--out', path])).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ saved: path, sizeBytes: bytes.length });
    expect(sessions.artifact).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'bounds transfer failures and retains validated subcodes (json=%s)',
    async (json) => {
      const { cli, out, err, sessions } = fixture();
      const failure = Object.assign(new Error('https://private.invalid/?token=synthetic-secret'), {
        code: 'POLICY_DENIED',
        details: {
          scope: 'SCOPE_HOST_DENIED',
          stage: 'redirect',
          reason: 'transferFailed',
          operationId: 'download-once',
          headers: { authorization: 'synthetic-secret' },
        },
      });
      sessions.download.mockRejectedValue(failure);
      sessions.collectDownload.mockRejectedValue(failure);
      expect(await cli.run([...(json ? ['--json'] : []), ...command])).toBe(1);
      expect(out).toEqual([]);
      expect(err).toHaveLength(1);
      if (json) {
        expect(JSON.parse(err[0]!)).toEqual({
          error: {
            code: 'POLICY_DENIED',
            message: 'Download failed (SCOPE_HOST_DENIED)',
            retryable: false,
            details: {
              scope: 'SCOPE_HOST_DENIED',
              stage: 'redirect',
              reason: 'transferFailed',
              operationId: 'download-once',
            },
          },
        });
      } else expect(err).toEqual(['POLICY_DENIED: Download failed (SCOPE_HOST_DENIED)']);
      expect(err.join('\n')).not.toMatch(/https|synthetic-secret|authorization/);
      expect(sessions.download.mock.calls.length + sessions.collectDownload.mock.calls.length).toBe(
        1
      );
    }
  );

  it('prints no success and no arbitrary error prose when artifact retrieval fails', async () => {
    const { cli, out, err, sessions } = fixture();
    sessions.artifact.mockRejectedValue(
      Object.assign(new Error('private-adapter-prose'), {
        code: 'UNKNOWN_private',
        details: { scope: 'SCOPE_HOST_DENIED private', stage: 'body private', reason: 'private' },
      })
    );
    expect(await cli.run(['--json', ...command, '--out', outputPath()])).toBe(1);
    expect(out).toEqual([]);
    expect(JSON.parse(err.join('\n'))).toEqual({
      error: { code: 'INTERNAL', message: 'Download failed', retryable: false },
    });
  });
});

it('honors collect --out when Commander parses it on the parent command', async () => {
  const { cli, out } = fixture();
  const path = outputPath();
  expect(
    await cli.run(['--json', 'download', '--out', path, 'collect', 's', 'p', 'dl_capture'])
  ).toBe(0);
  expect(readFileSync(path)).toEqual(bytes);
  expect(JSON.parse(out.join('\n'))).toMatchObject({ saved: path });
});
