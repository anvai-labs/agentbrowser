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
        details: {
          count: 2,
          inputs: [
            { index: 0, name: 'a', visible: false },
            { index: 1, name: 'b', visible: false },
          ],
          advice: expect.stringContaining('fileInputs'),
        },
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

  it('refuses a directory path as not a regular file, revision untouched', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url: 'data:text/html,<body><input type="file" style="display:none"></body>',
      });
      const dir = await mkdtemp(join(tmpdir(), 'ab-upload-'));
      const before = (await page.observe({})).revision;
      await expect(page.act({ type: 'upload', paths: [dir] })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        message: expect.stringContaining('Not a regular file'),
      });
      expect((await page.observe({})).revision).toBe(before);
    } finally {
      await engine.close();
    }
  });

  it('reports STALE_TARGET with remapEligible for a targeted upload whose element was detached', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      // Visible input so observe mints a ref. The page detaches it shortly
      // after load WITHOUT any agent action (no revision bump): the binding
      // outlives the node, and the targeted upload must refuse exactly like
      // any other targeted action - STALE_TARGET, remap-eligible.
      await page.navigate({
        url:
          'data:text/html,<body><input type="file" aria-label="Doc">' +
          '<script>setTimeout(function(){' +
          'var el=document.querySelector("input");' +
          'el.replaceWith(el.cloneNode(true));' +
          '},400);</script></body>',
      });
      const input = (await page.observe({ mode: 'interactive' })).elements.find(
        (element) => element.name === 'Doc'
      );
      if (!input) throw new Error('Missing fixture file input');
      const ref = input.ref;

      await new Promise((resolve) => setTimeout(resolve, 700));
      const dir = await mkdtemp(join(tmpdir(), 'ab-upload-'));
      const filePath = join(dir, 'sample.txt');
      await writeFile(filePath, 'x');

      await expect(
        page.act({ type: 'upload', target: { ref }, paths: [filePath] })
      ).rejects.toMatchObject({
        code: 'STALE_TARGET',
        details: { remapEligible: true },
      });
    } finally {
      await engine.close();
    }
  });

  it('mints refs for hidden and visible file inputs under include:["fileInputs"]', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      // Dropzone-style: a styled control backed by a display:none input plus
      // a plain visible input - the shape that makes untargeted upload
      // ambiguous on real pages.
      await page.navigate({
        url:
          'data:text/html,<body>' +
          '<label for="dropzone">Drop file</label>' +
          '<input type="file" id="dropzone" accept=".pdf,.doc" multiple style="display:none">' +
          '<input type="file" name="photo">' +
          '</body>',
      });

      const observation = await page.observe({ include: ['fileInputs'] });
      const fileInputs = observation.elements.filter((element) => element.role === 'fileinput');
      expect(fileInputs).toHaveLength(2);
      expect(new Set(fileInputs.map((element) => element.ref)).size).toBe(2);
      expect(fileInputs.map((element) => element.name)).toEqual(['Drop file', 'photo']);
      expect(fileInputs.map((element) => element.visible)).toEqual([false, true]);
      expect(fileInputs[0].attributes).toEqual({
        id: 'dropzone',
        accept: '.pdf,.doc',
        multiple: 'true',
      });
      expect(fileInputs[1].attributes).toEqual({});
    } finally {
      await engine.close();
    }
  });

  it('omits file-input elements without the include token', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url:
          'data:text/html,<body>' +
          '<input type="file" id="dropzone" style="display:none">' +
          '<input type="file" name="photo">' +
          '</body>',
      });
      const observation = await page.observe({});
      expect(observation.elements.some((element) => element.role === 'fileinput')).toBe(false);
    } finally {
      await engine.close();
    }
  });

  it('attaches to a hidden file input through its minted ref', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url:
          'data:text/html,<body>' +
          '<input type="file" id="dropzone" style="display:none">' +
          '<input type="file" name="photo">' +
          '</body>',
      });
      const dir = await mkdtemp(join(tmpdir(), 'ab-upload-'));
      const filePath = join(dir, 'sample.txt');
      const bytes = 'hidden-ref-upload';
      await writeFile(filePath, bytes);

      const hidden = (await page.observe({ include: ['fileInputs'] })).elements.find(
        (element) => element.role === 'fileinput' && element.visible === false
      );
      if (!hidden) throw new Error('Missing hidden file-input ref');

      const effect = await page.act({
        type: 'upload',
        target: { ref: hidden.ref },
        paths: [filePath],
      });
      const result = effect.result as { success?: boolean; inputFiles?: string[] };
      expect(result.success).toBe(true);
      expect(result.inputFiles).toEqual(['sample.txt']);
      expect(effect.newRevision).toBeGreaterThan(effect.oldRevision);
    } finally {
      await engine.close();
    }
  });

  it('reports STALE_TARGET for a hidden file-input ref whose element was replaced', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url:
          'data:text/html,<body><input type="file" id="dropzone" style="display:none">' +
          '<script>setTimeout(function(){' +
          'var el=document.getElementById("dropzone");' +
          'el.replaceWith(el.cloneNode(true));' +
          '},400);</script></body>',
      });
      const hidden = (await page.observe({ include: ['fileInputs'] })).elements.find(
        (element) => element.role === 'fileinput'
      );
      if (!hidden) throw new Error('Missing hidden file-input ref');
      const ref = hidden.ref;

      await new Promise((resolve) => setTimeout(resolve, 700));
      const dir = await mkdtemp(join(tmpdir(), 'ab-upload-'));
      const filePath = join(dir, 'sample.txt');
      await writeFile(filePath, 'x');

      await expect(
        page.act({ type: 'upload', target: { ref }, paths: [filePath] })
      ).rejects.toMatchObject({
        code: 'STALE_TARGET',
        details: { remapEligible: true },
      });
    } finally {
      await engine.close();
    }
  });

  it('keeps the revision stable across consecutive token-observations of a static page', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url:
          'data:text/html,<body>' +
          '<input type="file" id="dropzone" style="display:none">' +
          '</body>',
      });
      const first = await page.observe({ include: ['fileInputs'] });
      const second = await page.observe({ include: ['fileInputs'] });
      expect(second.revision).toBe(first.revision);
      expect(second.elements.map((element) => element.ref)).toEqual(
        first.elements.map((element) => element.ref)
      );
    } finally {
      await engine.close();
    }
  });

  it('honors the include token in content mode (DOM fallback path)', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url:
          'data:text/html,<body><p>Upload your resume</p>' +
          '<input type="file" id="dropzone" style="display:none">' +
          '</body>',
      });
      const observation = await page.observe({ mode: 'content', include: ['fileInputs'] });
      expect(
        observation.elements.some(
          (element) => element.role === 'fileinput' && element.visible === false
        )
      ).toBe(true);
    } finally {
      await engine.close();
    }
  });

  it('derives a real role (not empty) for bracketed-selector elements in the DOM fallback', async () => {
    // A near-zero snapshot budget forces every ariaSnapshot() call to time
    // out, so this exercises getContentElements() deterministically rather
    // than hoping a real page happens to time out. A bare <div role="button">
    // is only ever found through the '[role="button"]' selector - the exact
    // path that used to derive role as '' (stripping the whole bracket) and
    // crash the next observation's getByRole('') rebind (observed live
    // against LinkedIn's auth wall once its aria snapshot got slow).
    const engine = new PlaywrightChromiumEngine({ snapshotTimeoutMs: 1 });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url: 'data:text/html,<body><div role="button">Click me</div></body>',
      });
      const observation = await page.observe({ mode: 'interactive' });
      const button = observation.elements.find((element) => element.role === 'button');
      expect(button).toBeDefined();
      // The empty-role bug surfaced one observation later, when rebindRefs
      // tried to re-resolve every element via getByRole(element.role, ...).
      await expect(page.observe({ mode: 'interactive' })).resolves.toBeDefined();
    } finally {
      await engine.close();
    }
  });

  it('still refuses an untargeted upload with TARGET_NOT_FOUND when no file input exists', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: 'data:text/html,<body><p>No uploads here</p></body>' });
      const dir = await mkdtemp(join(tmpdir(), 'ab-upload-'));
      const filePath = join(dir, 'sample.txt');
      await writeFile(filePath, 'x');
      await expect(page.act({ type: 'upload', paths: [filePath] })).rejects.toMatchObject({
        code: 'TARGET_NOT_FOUND',
      });
    } finally {
      await engine.close();
    }
  });
});
