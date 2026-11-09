import type { EnginePage, EngineSession } from '@agentbrowser/engine';
import { describe, expect, it } from 'vitest';
import { backingPage } from './test-support/backing-page.js';
import { sharedEngine } from './test-support/shared-engine.js';

const engine = sharedEngine();

/** Fresh observation per action: any mutation invalidates the previous refs. */
async function refOf(page: EnginePage, role: string, name: string): Promise<string> {
  const state = await page.observe({});
  const element = state.elements.find((el) => el.role === role && el.name === name);
  if (!element?.ref) throw new Error(`missing observed ${role} "${name}"`);
  return element.ref;
}

/**
 * TD-BROWSER-18 gap 1 fixture: a Cloudflare-style custom combobox. The control
 * is a button carrying the ARIA combobox pattern (role=combobox,
 * aria-expanded, aria-haspopup=listbox, aria-controls) that toggles a
 * body-level (portaled) listbox on click; picking a row closes the popup and
 * records the pick where assertions can read it.
 */
const COMBOBOX_PAGE =
  'data:text/html,<button id="trigger" role="combobox" aria-expanded="false" aria-haspopup="listbox"' +
  ' aria-controls="list" aria-label="Region">Choose region</button>' +
  '<ul id="list" role="listbox" hidden><li role="option">eu-west-1</li><li role="option">us-east-1</li>' +
  '<li role="option">ap-south-1</li><li role="option" aria-disabled="true">disabled-region</li></ul>' +
  '<div id="picked"></div>' +
  '<script>' +
  'var b=document.getElementById("trigger"),l=document.getElementById("list");' +
  'b.addEventListener("click",function(){var open=b.getAttribute("aria-expanded")==="true";' +
  'b.setAttribute("aria-expanded",String(!open));l.hidden=open;});' +
  'l.addEventListener("click",function(e){var o=e.target.closest("[role=option]");if(!o)return;' +
  'b.textContent=o.textContent;b.setAttribute("aria-expanded","false");l.hidden=true;' +
  'document.getElementById("picked").textContent=o.textContent;});' +
  '</script>';

/**
 * A combobox that claims to be open but never renders rows: every bounded
 * wait runs out instead of burning the 30s actionability default.
 */
const NEVER_OPENS_PAGE =
  'data:text/html,<div id="trigger" role="combobox" aria-expanded="true" aria-autocomplete="list"' +
  ' aria-label="Filter" tabindex="0">Type to filter</div>';

describe('act select drives custom ARIA comboboxes (TD-18 gap 1, real Chromium)', () => {
  it('opens the popup, picks the requested row, and closes cleanly', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: COMBOBOX_PAGE });
      const native = backingPage(page);

      const comboRef = await refOf(page, 'combobox', 'Region');
      const before = (await page.observe({})).revision;
      const selected = await page.act({
        type: 'select',
        target: { ref: comboRef },
        values: ['eu-west-1'],
      });
      expect(selected.result).toEqual({ success: true });
      expect(selected.newRevision).toBeGreaterThan(selected.oldRevision);
      expect(selected.newRevision).toBeGreaterThan(before);
      expect(await native.locator('#picked').textContent()).toBe('eu-west-1');
      // The widget closed its popup on pick; the control label follows it.
      expect(await native.locator('#trigger').getAttribute('aria-expanded')).toBe('false');
      expect(await native.locator('#trigger').textContent()).toBe('eu-west-1');
    } finally {
      await session?.close();
    }
  });

  it('matches case-insensitively, then by substring, against visible row text', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: COMBOBOX_PAGE });

      await page.act({
        type: 'select',
        target: { ref: await refOf(page, 'combobox', 'Region') },
        values: ['US-EAST-1'],
      });
      expect(await backingPage(page).locator('#picked').textContent()).toBe('us-east-1');

      await page.act({
        type: 'select',
        target: { ref: await refOf(page, 'combobox', 'Region') },
        values: ['south'],
      });
      expect(await backingPage(page).locator('#picked').textContent()).toBe('ap-south-1');
    } finally {
      await session?.close();
    }
  });

  it('reopens the popup per value for multi-value selects', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: COMBOBOX_PAGE });

      const selected = await page.act({
        type: 'select',
        target: { ref: await refOf(page, 'combobox', 'Region') },
        values: ['eu-west-1', 'ap-south-1'],
      });
      expect(selected.result).toEqual({ success: true });
      expect(await backingPage(page).locator('#picked').textContent()).toBe('ap-south-1');
    } finally {
      await session?.close();
    }
  });

  it('refuses a missing value with the bounded observed option list', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: COMBOBOX_PAGE });

      const error = await page
        .act({
          type: 'select',
          target: { ref: await refOf(page, 'combobox', 'Region') },
          values: ['sa-east-1'],
        })
        .catch((cause: { code?: string; message?: string }) => cause);
      expect(error.code).toBe('TARGET_NOT_FOUND');
      expect(error.message).toContain('"eu-west-1"');
      expect(error.message).toContain('"us-east-1"');
      expect(error.message).toContain('"sa-east-1"');
    } finally {
      await session?.close();
    }
  });

  it('skips aria-disabled rows and reports them as unavailable', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: COMBOBOX_PAGE });

      const error = await page
        .act({
          type: 'select',
          target: { ref: await refOf(page, 'combobox', 'Region') },
          values: ['disabled-region'],
        })
        .catch((cause: { code?: string; message?: string }) => cause);
      expect(error.code).toBe('TARGET_NOT_FOUND');
      expect(await backingPage(page).locator('#picked').textContent()).toBe('');
    } finally {
      await session?.close();
    }
  });

  it('times out bounded — never the 30s default — when no rows ever render', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: NEVER_OPENS_PAGE });

      const started = Date.now();
      const error = await page
        .act({
          type: 'select',
          target: { ref: await refOf(page, 'combobox', 'Filter') },
          values: ['anything'],
        })
        .catch((cause: { code?: string; message?: string }) => cause);
      expect(error.code).toBe('ACTION_TIMEOUT');
      expect(error.message).toContain('typing-filter comboboxes');
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await session?.close();
    }
  });
});
