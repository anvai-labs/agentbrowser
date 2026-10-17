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
        await cli.run(['--json', 'screenshot', 'ses_1', 'pg_1', '--out', path, '--inline'])
      ).toBe(0);
      expect(JSON.parse(out[0]!).inline.contentBase64).toBe(contentBase64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
