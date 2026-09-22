import type { EngineEvent, EnginePage } from '@agentbrowser/engine';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

function backingPage(page: EnginePage): Page {
  return (page as unknown as { backingPage(): Page }).backingPage();
}

/** Wait for an engine event to arrive instead of guessing with a fixed sleep. */
async function waitForEvent(
  events: EngineEvent[],
  type: EngineEvent['type'],
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a ${type} event`);
}

const PROMPT_PAGE =
  'data:text/html,<html><body>' +
  '<input id="out" aria-label="Out" readonly />' +
  "<button id=\"a\" onclick=\"document.getElementById('out').value = prompt('Name?', '') || ''\">Ask</button>" +
  '</body></html>';

const ALERT_PAGE =
  'data:text/html,<html><body><button onclick="alert(\'held\')">Hold</button></body></html>';

/**
 * Held-dialog handling and renderer-crash events, plus observation details
 * the older suites never asserted: mixed checkbox state and the overlay
 * census's skip rules.
 */
describe('held dialogs, crashes, and observation details (real Chromium)', () => {
  it('dismisses a held prompt without answering it and refuses dialog actions with none held', async () => {
    const engine = new PlaywrightChromiumEngine({ dialogGraceMs: 60_000 });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: PROMPT_PAGE });
      const ask = (await page.observe({})).elements.find((el) => el.name === 'Ask');
      if (!ask?.ref) throw new Error('missing observed Ask button');

      // With nothing held, dialog actions refuse as caller mistakes.
      await expect(page.act({ type: 'acceptDialog' })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
      await expect(page.act({ type: 'dismissDialog' })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });

      const events: EngineEvent[] = [];
      (async () => {
        for await (const event of page.events()) {
          events.push(event);
        }
      })().catch(() => {});

      // The triggering click stalls while the dialog is held: fire without
      // awaiting, settle the dialog through the dialog action.
      const clickPromise = page.act({ type: 'click', target: { ref: ask.ref } }).catch(() => {});
      await waitForEvent(events, 'dialog.opened');

      const effect = await page.act({ type: 'dismissDialog' });
      expect(effect.result).toEqual({ dialog: 'dismissed' });
      expect(effect.newRevision).toBe(effect.oldRevision); // non-mutating
      await clickPromise;

      await waitForEvent(events, 'dialog.closed');
      // A dismissed prompt answers null: the page records the empty string.
      const out = (await page.observe({})).elements.find((el) => el.name === 'Out');
      expect(out?.value === '' || out?.value === undefined).toBe(true);
      expect(events.some((e) => e.type === 'dialog.closed' && e.data?.reason === 'dismissed')).toBe(
        true
      );
    } finally {
      await engine.close();
    }
  });

  it('closes cleanly with a dialog still held and cancels its auto-settle', async () => {
    const engine = new PlaywrightChromiumEngine({ dialogGraceMs: 700 });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: ALERT_PAGE });
      const hold = (await page.observe({})).elements.find((el) => el.name === 'Hold');
      if (!hold?.ref) throw new Error('missing observed Hold button');

      const events: EngineEvent[] = [];
      (async () => {
        for await (const event of page.events()) {
          events.push(event);
        }
      })().catch(() => {});

      const clickPromise = page.act({ type: 'click', target: { ref: hold.ref } }).catch(() => {});
      await waitForEvent(events, 'dialog.opened');

      await page.close();
      await clickPromise;

      // The held dialog's timer was cleared: even past the 700ms grace, no
      // auto-settle dialog.closed may appear.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(events.some((e) => e.type === 'dialog.closed' && e.data?.reason === 'auto')).toBe(
        false
      );
    } finally {
      await engine.close();
    }
  });

  it('announces page.crashed on the event stream when the renderer dies', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: 'data:text/html,<title>Doomed</title>' });

      const events: EngineEvent[] = [];
      (async () => {
        for await (const event of page.events()) {
          events.push(event);
        }
      })().catch(() => {});

      // Induce a real renderer crash through Chromium's DevTools protocol;
      // the crash kills the renderer mid-command, so the send never settles.
      const backing = backingPage(page);
      const cdp = await backing.context().newCDPSession(backing);
      void cdp.send('Page.crash').catch(() => {});

      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (events.some((e) => e.type === 'page.crashed')) {
            resolve();
            return;
          }
          if (Date.now() - started > 10_000) {
            reject(new Error('page.crashed never arrived'));
            return;
          }
          setTimeout(poll, 100);
        };
        poll();
      });
      const crashed = events.find((e) => e.type === 'page.crashed');
      expect(crashed?.pageId).toBe(page.id);
    } finally {
      await engine.close();
    }
  });

  it('reports a mixed-state checkbox as present-but-unknown checked', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url:
          'data:text/html,<label>Mix<input type="checkbox" id="mix"></label>' +
          "<script>document.getElementById('mix').indeterminate = true;</script>",
      });
      const mix = (await page.observe({})).elements.find((el) => el.role === 'checkbox');
      if (!mix) throw new Error('missing observed checkbox');

      // Tri-state mixed is recorded as present-but-undefined: unknowable,
      // never silently false.
      expect('checked' in mix).toBe(true);
      expect(mix.checked).toBeUndefined();
    } finally {
      await engine.close();
    }
  });

  it('excludes hidden and unbindable elements from the overlay census without failing', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url:
          'data:text/html,<button>Plain</button>' +
          '<input type="file" style="display:none" aria-label="Hidden upload" accept=".png">' +
          '<iframe title="Framed" srcdoc="<b>x</b>"></iframe>',
      });
      const state = await page.observe({ include: ['overlays', 'fileInputs'] });

      // The hidden file input is observed but invisible: never probed.
      const hidden = state.elements.find((el) => el.role === 'fileinput');
      if (!hidden) throw new Error('missing observed fileinput');
      expect(hidden.visible).toBe(false);
      // The iframe is in the snapshot but its role cannot bind to a locator.
      const frame = state.elements.find((el) => el.role === 'iframe');
      if (!frame) throw new Error('missing observed iframe');
      expect(frame.visible).toBe(true);

      // Neither crashed the census, and nothing occludes the plain button.
      expect(state.overlays).toEqual([]);
    } finally {
      await engine.close();
    }
  });
});
