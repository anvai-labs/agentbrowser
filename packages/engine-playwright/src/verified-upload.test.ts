import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnginePage } from '@agentbrowser/engine';
import { expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

async function fixture(
  test: (
    page: EnginePage,
    backing: import('playwright').Page,
    path: string,
    bytes: Buffer,
    digest: string
  ) => Promise<void>
) {
  const engine = new PlaywrightChromiumEngine();
  const dir = await mkdtemp(join(tmpdir(), 'ab-verified-upload-'));
  try {
    const page = await (await engine.createSession({ headless: true })).newPage();
    const backing = (
      page as EnginePage & { backingPage(): import('playwright').Page }
    ).backingPage();
    await backing.setContent(
      '<input id="resume" type="file" style="display:none" onchange="window.changes=(window.changes||0)+1">'
    );
    const bytes = Buffer.from([0, 255, 128, 10, 65]);
    const path = join(dir, 'fixture.pdf');
    await writeFile(path, bytes);
    await test(page, backing, path, bytes, createHash('sha256').update(bytes).digest('hex'));
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}

it.each([false, true])(
  'rejects digest mismatch before upload effects (targeted=%s)',
  async (targeted) => {
    await fixture(async (page, backing, path) => {
      const before = await page.observe({ include: ['fileInputs'] });
      const input = before.elements.find((element) => element.role === 'fileinput')!;
      await expect(
        page.act({
          type: 'upload',
          paths: [path],
          sha256: '0'.repeat(64),
          ...(targeted ? { target: { ref: input.ref } } : {}),
        })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(
        await backing.locator('#resume').evaluate((input: HTMLInputElement) => input.files?.length)
      ).toBe(0);
      expect(
        await backing.evaluate(() => (window as unknown as { changes?: number }).changes ?? 0)
      ).toBe(0);
    });
  }
);

it.each([false, true])(
  'uploads exactly the checked bytes and MIME metadata (targeted=%s)',
  async (targeted) => {
    await fixture(async (page, backing, path, bytes, digest) => {
      let target: { ref: string } | undefined;
      if (targeted) {
        await backing.locator('body').evaluate((body) => {
          const other = document.createElement('input');
          other.type = 'file';
          other.id = 'other';
          body.append(other);
        });
        const view = await page.observe({ include: ['fileInputs'] });
        target = {
          ref: view.elements.find((element) => element.role === 'fileinput' && !element.visible)!
            .ref,
        };
      }
      const result = await page.act({
        type: 'upload',
        paths: [path],
        sha256: digest,
        mimeType: 'application/pdf',
        ...(target ? { target } : {}),
      });
      expect(result.result).toMatchObject({
        success: true,
        files: [{ name: 'fixture.pdf', size: bytes.length, sha256: digest }],
      });
      expect(
        await backing.locator('#resume').evaluate(async (input: HTMLInputElement) => {
          const file = input.files![0]!;
          return {
            bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
            type: file.type,
            name: file.name,
          };
        })
      ).toEqual({ bytes: [...bytes], type: 'application/pdf', name: 'fixture.pdf' });
      expect(await backing.evaluate(() => (window as unknown as { changes: number }).changes)).toBe(
        1
      );
      if (targeted)
        expect(
          await backing.locator('#other').evaluate((input: HTMLInputElement) => input.files?.length)
        ).toBe(0);
    });
  }
);

it('refuses an ambiguous checked upload without attaching either input', async () => {
  await fixture(async (page, backing, path, _bytes, digest) => {
    await backing.locator('body').evaluate((body) => {
      const input = document.createElement('input');
      input.type = 'file';
      body.append(input);
    });
    await expect(page.act({ type: 'upload', paths: [path], sha256: digest })).rejects.toMatchObject(
      { code: 'TARGET_AMBIGUOUS' }
    );
    expect(
      await backing
        .locator('input')
        .evaluateAll((inputs: HTMLInputElement[]) => inputs.map((input) => input.files?.length))
    ).toEqual([0, 0]);
  });
});

it.each([
  { sha256: 'not-a-digest' },
  { sha256: 'A'.repeat(64) },
  { mimeType: 'application/pdf' },
  { sha256: 'valid', mimeType: 'invalid\nmetadata' },
  { sha256: 'valid', mimeType: 'application/pdf\n' },
])('rejects malformed direct-engine upload metadata %j', async (metadata) => {
  await fixture(async (page, backing, path, _bytes, digest) => {
    await expect(
      page.act({
        type: 'upload',
        paths: [path],
        ...metadata,
        ...(metadata.sha256 === 'valid' ? { sha256: digest } : {}),
      })
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(
      await backing.locator('#resume').evaluate((input: HTMLInputElement) => input.files?.length)
    ).toBe(0);
  });
});

it('rejects multiple paths for checked uploads before browser effects', async () => {
  await fixture(async (page, backing, path, _bytes, digest) => {
    await expect(
      page.act({ type: 'upload', paths: [path, path], sha256: digest })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(
      await backing.locator('#resume').evaluate((input: HTMLInputElement) => input.files?.length)
    ).toBe(0);
  });
});

it('rejects integrity metadata on non-upload actions for direct engine callers', async () => {
  await fixture(async (page, _backing, _path, _bytes, digest) => {
    await expect(page.act({ type: 'wait', ms: 0, sha256: digest })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});
