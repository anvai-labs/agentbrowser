import http from 'node:http';
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

/** Poll until an observation surfaces the element (frames attach async). */
async function refOfEventually(
  page: EnginePage,
  role: string,
  name: string,
  timeoutMs = 10_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.observe({ mode: 'interactive' });
    const element = state.elements.find((el) => el.role === role && el.name === name);
    if (element?.ref) return element.ref;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`missing observed ${role} "${name}"`);
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

/** Shared click-open wiring: toggle aria-expanded + listbox visibility on
 * control click; picking a row closes the popup and records the pick. */
const WIRE_FN =
  '<script>' +
  'function wire(b,l,p){var B=document.getElementById(b),L=document.getElementById(l);' +
  'B.addEventListener("click",function(){var open=B.getAttribute("aria-expanded")==="true";' +
  'B.setAttribute("aria-expanded",String(!open));L.hidden=open;});' +
  'L.addEventListener("click",function(e){var o=e.target.closest("[role=option]");if(!o)return;' +
  'B.textContent=o.textContent;B.setAttribute("aria-expanded","false");L.hidden=true;' +
  'document.getElementById(p).textContent=o.textContent;});}</script>';

const wire = (button: string, list: string, picked: string): string =>
  `${WIRE_FN}<script>wire("${button}","${list}","${picked}");</script>`;

/**
 * Two comboboxes whose listboxes are DOM-resident (always displayed): the
 * requested row's scoped ordinal in its own listbox differs from its
 * document-wide [role=option] ordinal, so this page would catch a main-frame
 * nth() click drifting into the first combobox's rows.
 */
const TWO_LISTBOXES_PAGE =
  'data:text/html,<button id="a" role="combobox" aria-expanded="false" aria-haspopup="listbox"' +
  ' aria-controls="la" aria-label="Alpha">Alpha</button>' +
  '<ul id="la" role="listbox"><li role="option">alpha-1</li><li role="option">alpha-2</li>' +
  '<li role="option">alpha-3</li></ul>' +
  '<button id="b" role="combobox" aria-expanded="false" aria-haspopup="listbox"' +
  ' aria-controls="lb" aria-label="Beta">Beta</button>' +
  '<ul id="lb" role="listbox"><li role="option">beta-1</li><li role="option">beta-2</li></ul>' +
  '<div id="picked-a"></div><div id="picked-b"></div>' +
  wire('a', 'la', 'picked-a') +
  wire('b', 'lb', 'picked-b');

/** The combobox fixture served inside a child iframe (same-origin http). */
const IFRAME_COMBOBOX_DOCUMENT =
  '<button id="trigger" role="combobox" aria-expanded="false" aria-haspopup="listbox"' +
  ' aria-controls="list" aria-label="Region">Choose region</button>' +
  '<ul id="list" role="listbox" hidden><li role="option">frame-row-1</li>' +
  '<li role="option">frame-row-2</li></ul><div id="picked"></div>' +
  wire('trigger', 'list', 'picked');

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
      expect(selected.result).toEqual({ success: true, matchedOption: 'eu-west-1' });
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

      const substring = await page.act({
        type: 'select',
        target: { ref: await refOf(page, 'combobox', 'Region') },
        values: ['south'],
      });
      expect(substring.result).toEqual({ success: true, matchedOption: 'ap-south-1' });
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
      expect(selected.result).toEqual({ success: true, matchedOption: 'ap-south-1' });
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

  it('picks the scoped row when a second DOM-resident listbox sits earlier in the document', async () => {
    // The requested row's ordinal inside its aria-controls listbox (1) differs
    // from its document-wide ordinal (4): a main-frame [role=option] nth()
    // click would land in the FIRST combobox's rows instead.
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: TWO_LISTBOXES_PAGE });
      const native = backingPage(page);

      const selected = await page.act({
        type: 'select',
        target: { ref: await refOf(page, 'combobox', 'Beta') },
        values: ['beta-2'],
      });
      // Review R1: the matched row surfaces in the result, so a wrong pick is visible.
      expect(selected.result).toEqual({ success: true, matchedOption: 'beta-2' });
      expect(await native.locator('#picked-b').textContent()).toBe('beta-2');
      expect(await native.locator('#picked-a').textContent()).toBe('');
    } finally {
      await session?.close();
    }
  });

  it('drives a combobox observed inside a child iframe through its own frame', async () => {
    const server = http.createServer((request, response) => {
      const body =
        request.url === '/frame'
          ? IFRAME_COMBOBOX_DOCUMENT
          : '<iframe src="/frame" title="Embedded"></iframe>';
      response.writeHead(200, { 'content-type': 'text/html' }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: origin });

      const frame = () =>
        backingPage(page)
          .frames()
          .find((candidate) => candidate.url().endsWith('/frame'));
      const comboRef = await refOfEventually(page, 'combobox', 'Region');
      const selected = await page.act({
        type: 'select',
        target: { ref: comboRef },
        values: ['frame-row-2'],
      });
      expect(selected.result).toEqual({ success: true, matchedOption: 'frame-row-2' });
      expect(await frame()?.locator('#picked').textContent()).toBe('frame-row-2');
      expect(await frame()?.locator('#trigger').getAttribute('aria-expanded')).toBe('false');
    } finally {
      await session?.close();
      await new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
    }
  });
});
