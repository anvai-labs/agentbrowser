import http from 'node:http';
import type { EnginePage } from '@agentbrowser/engine';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

function backingPage(page: EnginePage): Page {
  return (page as unknown as { backingPage(): Page }).backingPage();
}

/** Fresh observation per action: any mutation invalidates the previous refs. */
async function refOf(page: EnginePage, role: string, name: string): Promise<string> {
  const state = await page.observe({});
  const element = state.elements.find((el) => el.role === role && el.name === name);
  if (!element?.ref) throw new Error(`missing observed ${role} "${name}"`);
  return element.ref;
}

const FORM_PAGE =
  'data:text/html,<label>Color<select aria-label="Color"><option>Red</option><option>Blue</option></select></label>' +
  '<label>Subscribe<input type="checkbox" aria-label="Subscribe"></label>' +
  '<label>Bio<textarea aria-label="Bio"></textarea></label>';

/**
 * Delivered action types the older suites never exercised end to end:
 * select, check/uncheck, clear, history goBack, unknown-type recording,
 * the vestigial extract port, title reads, per-page viewports, and the
 * upload argument guard.
 */
describe('delivered action matrix gaps (real Chromium)', () => {
  it('selects options, toggles checkbox state, and clears a field through observed refs', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: FORM_PAGE });
      const native = backingPage(page);

      const colorRef = await refOf(page, 'combobox', 'Color');
      const selected = await page.act({
        type: 'select',
        target: { ref: colorRef },
        values: ['Blue'],
      });
      expect(selected.result).toEqual({ success: true });
      expect(selected.newRevision).toBeGreaterThan(selected.oldRevision);
      expect(await native.locator('select').inputValue()).toBe('Blue');

      const checkRef = await refOf(page, 'checkbox', 'Subscribe');
      await page.act({ type: 'check', target: { ref: checkRef } });
      const checked = (await page.observe({})).elements.find((el) => el.name === 'Subscribe');
      expect(checked?.checked).toBe(true);

      const uncheckRef = await refOf(page, 'checkbox', 'Subscribe');
      await page.act({ type: 'uncheck', target: { ref: uncheckRef } });
      const unchecked = (await page.observe({})).elements.find((el) => el.name === 'Subscribe');
      expect(unchecked?.checked).toBe(false);

      const bioRef = await refOf(page, 'textbox', 'Bio');
      await page.act({ type: 'fill', target: { ref: bioRef }, value: 'draft text' });
      const filled = (await page.observe({})).elements.find((el) => el.name === 'Bio');
      expect(filled?.value).toBe('draft text');

      const clearRef = await refOf(page, 'textbox', 'Bio');
      await page.act({ type: 'clear', target: { ref: clearRef } });
      const cleared = (await page.observe({})).elements.find((el) => el.name === 'Bio');
      expect(cleared?.value === '' || cleared?.value === undefined).toBe(true);
    } finally {
      await engine.close();
    }
  });

  it('bumps the revision on goBack across real http history and records unknown action types without one', async () => {
    const server = http.createServer((request, response) => {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(`<!DOCTYPE html><title>${request.url}</title><body>${request.url}</body>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: `${origin}/one` });
      await page.navigate({ url: `${origin}/two` });

      // History navigation with a real entry returns a response: refs must
      // be invalidated (data: URLs have no history, so goBack never bumped).
      const back = await page.act({ type: 'goBack' });
      expect(back.result).toEqual({ success: true });
      expect(back.newRevision).toBeGreaterThan(back.oldRevision);
      expect(await page.getUrl()).toBe(`${origin}/one`);

      // Unhandled action types are recorded, not refused, and mutate nothing.
      const before = (await page.observe({})).revision;
      const unknown = await page.act({ type: 'voiceCommand', text: 'hello' });
      expect(unknown.result).toEqual({ success: true });
      expect(unknown.newRevision).toBe(before);
      expect(unknown.newRevision).toBe(unknown.oldRevision);

      await session.close();
    } finally {
      await engine.close();
      await new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
    }
  });

  it('extracts body text, reads the title until the page closes, and closes twice cleanly', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url: 'data:text/html,<title>Matrix</title><p>extraction marker 4021</p>',
      });

      const extraction = await page.extract({ format: 'text' });
      const data = extraction.data as { text?: string };
      expect(data.text).toContain('extraction marker 4021');
      expect(extraction.warnings).toEqual([]);

      expect(await page.getTitle?.()).toBe('Matrix');
      await page.close();
      expect(await page.getTitle?.()).toBeUndefined();
      expect(page.getCachedUrl?.()).toBeUndefined();
      // A closed page refuses URL reads as PAGE_NOT_FOUND, never lies.
      await expect(page.getUrl()).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });

      // A second close is a no-op, not an error.
      await expect(session.close()).resolves.toBeUndefined();
      await expect(session.close()).resolves.toBeUndefined();
    } finally {
      await engine.close();
    }
  });

  it('applies a per-page viewport at creation', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage({ viewport: { width: 390, height: 844 } });
      expect(
        await backingPage(page).evaluate(() => [window.innerWidth, window.innerHeight])
      ).toEqual([390, 844]);
      await page.close();
      await session.close();
    } finally {
      await engine.close();
    }
  });

  it('refuses an upload with no paths as a caller mistake before touching the page', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: FORM_PAGE });

      await expect(page.act({ type: 'upload' })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
      await page.close();
      await session.close();
    } finally {
      await engine.close();
    }
  });
});
