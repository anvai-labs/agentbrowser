import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

describe('real action wire semantics', () => {
  it('delivers directional scroll and untargeted keyboard input', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url: 'data:text/html,<body style="height:5000px"><input aria-label="Input"></body>',
      });
      // Establish focus explicitly: browser autofocus is scheduled after
      // navigation and is not the contract this keyboard test exercises.
      const input = (await page.observe({ mode: 'interactive' })).elements.find(
        (element) => element.name === 'Input'
      );
      if (!input) throw new Error('Missing fixture input');
      await page.act({ type: 'click', target: { ref: input.ref } });
      await page.act({ type: 'press', key: 'A' });
      expect(
        (await page.observe({ mode: 'interactive' })).elements.some(
          (element) => element.value === 'A'
        )
      ).toBe(true);
      await page.act({ type: 'scroll', direction: 'down', amount: 400 });
      const backing = (
        page as unknown as { backingPage(): import('playwright').Page }
      ).backingPage();
      await expect.poll(() => backing.evaluate(() => scrollY)).toBeGreaterThan(0);
    } finally {
      await engine.close();
    }
  });

  it('attaches local files to a hidden file input without a ref and reports evidence', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      // Hidden input: observe never mints a ref for it, so the un-targeted
      // upload path is the only one a caller could have here.
      await page.navigate({
        url:
          'data:text/html,<body><form><input type="file" name="doc" style="display:none">' +
          '<button type="submit">Go</button></form></body>',
      });
      const dir = await mkdtemp(join(tmpdir(), 'ab-upload-'));
      const filePath = join(dir, 'sample.txt');
      const bytes = 'upload-evidence';
      await writeFile(filePath, bytes);

      const effect = await page.act({ type: 'upload', paths: [filePath] });
      const result = effect.result as {
        success?: boolean;
        files?: Array<{ name: string; size: number }>;
        inputFiles?: string[];
      };
      expect(result.success).toBe(true);
      expect(result.files).toEqual([{ name: 'sample.txt', size: bytes.length }]);
      // Browser-verified evidence, not just the server-side stat.
      expect(result.inputFiles).toEqual(['sample.txt']);
      // A successful upload mutates page state: the revision moves.
      expect(effect.newRevision).toBeGreaterThan(effect.oldRevision);
    } finally {
      await engine.close();
    }
  });

  it('refuses an untargeted upload when file inputs are ambiguous', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url:
          'data:text/html,<body>' +
          '<input type="file" name="a" style="display:none">' +
          '<input type="file" name="b" style="display:none">' +
          '</body>',
      });
      const dir = await mkdtemp(join(tmpdir(), 'ab-upload-'));
      const filePath = join(dir, 'sample.txt');
      await writeFile(filePath, 'x');
      await expect(page.act({ type: 'upload', paths: [filePath] })).rejects.toMatchObject({
        code: 'TARGET_AMBIGUOUS',
      });
    } finally {
      await engine.close();
    }
  });

  it('rejects a missing local path before touching the page', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url: 'data:text/html,<body><input type="file" style="display:none"></body>',
      });
      await expect(
        page.act({ type: 'upload', paths: ['/nonexistent/path/x.pdf'] })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    } finally {
      await engine.close();
    }
  });
});
