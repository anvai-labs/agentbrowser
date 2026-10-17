import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildCli, type CliClient } from './cli.js';

describe('screenshot file receipts', () => {
  it.each([221231, 1130000])('saves %i bytes without inline output', async (size) => {
    const dir = mkdtempSync(join(tmpdir(), 'screenshot-output-'));
    try {
      const bytes = Buffer.alloc(size, 97);
      const contentBase64 = bytes.toString('base64');
      const artifact = {
        artifactId: 'art_1',
        contentType: 'image/png',
        sizeBytes: size,
        url: '/artifacts/art_1?token=synthetic-signed-secret',
        ...(size < 300000 ? { inline: { contentBase64 } } : {}),
      };
      const out: string[] = [];
      const cli = buildCli({
        out: (line) => out.push(line),
        err: () => {},
        createClient: () =>
          ({
            sessions: {
              screenshot: vi.fn().mockResolvedValue(artifact),
              artifact: vi.fn().mockResolvedValue({ contentBase64 }),
            },
          }) as unknown as CliClient,
      });
      const path = join(dir, 'shot.png');
      expect(await cli.run(['--json', 'screenshot', 'ses_1', 'pg_1', '--out', path])).toBe(0);
      expect(readFileSync(path).equals(bytes)).toBe(true);
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0]!)).toMatchObject({
        artifactId: 'art_1',
        saved: path,
        sizeBytes: size,
      });
      expect(out.join('')).not.toContain('contentBase64');
      expect(out.join('')).not.toContain('synthetic-signed-secret');
      expect(out.join('').length).toBeLessThan(1024);
      out.length = 0;
      expect(
        await cli.run([
          '--json',
          'screenshot',
          'ses_1',
          'pg_1',
          '--out',
          join(dir, 'inline.png'),
          '--inline',
        ])
      ).toBe(0);
      expect(JSON.parse(out[0]!).inline.contentBase64).toBe(contentBase64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it.each(['screenshot', 'pdf', 'html', 'artifact'])(
  '%s defaults to a private file receipt for a large payload',
  async (kind) => {
    const bytes = Buffer.alloc(1130000, 97);
    const artifact = {
      artifactId: 'a',
      type: kind === 'artifact' ? 'screenshot' : kind,
      contentType: kind === 'html' ? 'text/html' : kind === 'pdf' ? 'application/pdf' : 'image/png',
      sizeBytes: bytes.length,
      url: '/signed?token=synthetic-secret',
      inline: { contentBase64: bytes.toString('base64'), byteSize: bytes.length },
    };
    const out: string[] = [];
    const retrieve = vi
      .fn()
      .mockResolvedValue({ metadata: artifact, contentBase64: artifact.inline.contentBase64 });
    const cli = buildCli({
      out: (line) => out.push(line),
      err: () => {},
      createClient: () =>
        ({
          sessions: {
            screenshot: vi.fn().mockResolvedValue(artifact),
            pdf: vi.fn().mockResolvedValue(artifact),
            html: vi.fn().mockResolvedValue(artifact),
            artifact: retrieve,
          },
        }) as unknown as CliClient,
    });
    const command =
      kind === 'html'
        ? ['page', 'html', 's', 'p']
        : kind === 'artifact'
          ? ['artifact', 'get', 's', 'a']
          : [kind, 's', 'p'];
    expect(await cli.run(['--json', ...command])).toBe(0);
    expect(out).toHaveLength(1);
    const receipt = JSON.parse(out[0]!);
    expect(readFileSync(receipt.file.path).equals(bytes)).toBe(true);
    expect(receipt.file.expiresAt).toBeGreaterThan(Date.now());
    expect(out[0]!.length).toBeLessThan(1024);
    expect(out[0]).not.toContain('synthetic-secret');
    expect(out[0]).not.toContain('contentBase64');
    expect(retrieve).toHaveBeenCalledTimes(kind === 'artifact' ? 1 : 0);
  }
);

it('rejects an unusable cache without printing the payload or using a second directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-cache-fail-'));
  const previous = process.env.AGENTBROWSER_ARTIFACT_DIR;
  process.env.AGENTBROWSER_ARTIFACT_DIR = join(dir, 'not-a-directory');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.AGENTBROWSER_ARTIFACT_DIR, 'keep');
  try {
    const out: string[] = [];
    const err: string[] = [];
    const cli = buildCli({
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      createClient: () =>
        ({
          sessions: {
            screenshot: vi.fn().mockResolvedValue({
              artifactId: 'a',
              contentType: 'image/png',
              inline: {
                contentBase64: Buffer.from('private fixture content').toString('base64'),
              },
            }),
          },
        }) as unknown as CliClient,
    });
    expect(await cli.run(['--json', 'screenshot', 's', 'p'])).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('')).toContain('private artifact cache');
    expect(err.join('')).not.toContain('private fixture content');
  } finally {
    if (previous === undefined) delete process.env.AGENTBROWSER_ARTIFACT_DIR;
    else process.env.AGENTBROWSER_ARTIFACT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
