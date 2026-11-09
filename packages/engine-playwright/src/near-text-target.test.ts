import type { EnginePage, EngineSession } from '@agentbrowser/engine';
import { describe, expect, it } from 'vitest';
import { backingPage } from './test-support/backing-page.js';
import { sharedEngine } from './test-support/shared-engine.js';

const engine = sharedEngine();

/**
 * TD-BROWSER-18 gap 6: near-text targeting — the geometric escape hatch for
 * controls with no accessible name (Cloudflare settings rows with a bare
 * "+ Add"). Fixture: three settings rows, each a label and an unlabeled
 * button; rows are 60px tall so their bands never overlap.
 */
const SETTINGS_ROWS =
  'data:text/html,<title>Settings</title><style>div.row{height:60px}button{width:24px;height:24px}</style>' +
  '<div class="row"><span>Security</span><button data-row="security">+</button></div>' +
  '<div class="row"><span>Billing</span><button data-row="billing">+</button></div>' +
  '<div class="row"><span>Networking</span><button data-row="networking">+</button></div>';

/** A fixture that distinguishes nearest from row semantics: one control
 * directly left of the label (nearest, but not trailing) and one far to its
 * right (trailing). */
const NEAREST_VS_ROW =
  'data:text/html,<title>Nearest</title><style>div.row{height:40px}button{width:24px;height:24px}span.gap{display:inline-block;width:200px}</style>' +
  '<div class="row"><button id="left">e</button><span>Alerts</span><span class="gap"></span><button id="right">+</button></div>';

async function newPage(session: EngineSession): Promise<EnginePage> {
  const page = await session.newPage();
  await page.navigate({ url: SETTINGS_ROWS });
  return page;
}

describe('near-text targets (TD-BROWSER-18 gap 6, real Chromium)', () => {
  it('row:true clicks the trailing button of the matching row, not another row', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await newPage(session);
      const native = backingPage(page);
      await native.evaluate(() => {
        const clicked: string[] = [];
        (globalThis as unknown as { __clicked: string[] }).__clicked = clicked;
        for (const button of document.querySelectorAll('button')) {
          button.addEventListener('click', () =>
            clicked.push(button.getAttribute('data-row') ?? '')
          );
        }
      });

      const effect = await page.act({
        type: 'click',
        target: { nearText: 'Billing', row: true },
      });
      expect(effect.result).toEqual({ success: true });
      const clicked = await native.evaluate(
        () => (globalThis as unknown as { __clicked: string[] }).__clicked
      );
      expect(clicked).toEqual(['billing']);
    } finally {
      await session?.close();
    }
  });

  it('nearest mode picks the geometrically closest control even when it does not trail', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: NEAREST_VS_ROW });
      const native = backingPage(page);
      await native.evaluate(() => {
        const clicked: string[] = [];
        (globalThis as unknown as { __clicked: string[] }).__clicked = clicked;
        for (const id of ['left', 'right']) {
          document.getElementById(id)?.addEventListener('click', () => clicked.push(id));
        }
      });

      // row:true prefers the trailing control despite the distance.
      await page.act({ type: 'click', target: { nearText: 'Alerts', row: true } });
      expect(
        await native.evaluate(() => (globalThis as unknown as { __clicked: string[] }).__clicked)
      ).toEqual(['right']);

      // Plain nearest keeps the closest control (the adjacent one on the left).
      await page.act({ type: 'click', target: { nearText: 'Alerts' } });
      expect(
        await native.evaluate(() => (globalThis as unknown as { __clicked: string[] }).__clicked)
      ).toEqual(['right', 'left']);
    } finally {
      await session?.close();
    }
  });

  it('refuses TARGET_NOT_FOUND when no visible text matches', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await newPage(session);
      await expect(
        page.act({ type: 'click', target: { nearText: 'Does Not Exist' } })
      ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
    } finally {
      await session?.close();
    }
  });

  it('refuses TARGET_NOT_FOUND when text matches but no interactive element is nearby', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url: 'data:text/html,<title>Plain</title><p>orphan label text</p>',
      });
      await expect(
        page.act({ type: 'click', target: { nearText: 'orphan label', row: true } })
      ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
    } finally {
      await session?.close();
    }
  });

  it('refuses TARGET_AMBIGUOUS and lists candidates when two controls tie', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      // Both buttons overlap the label's text box in both axes, so each has
      // exactly zero rect-to-rect distance — a genuine geometric tie.
      await page.navigate({
        url:
          'data:text/html,<title>Tie</title><style>button{display:block;width:200px;height:20px}div.wrap{position:relative;line-height:20px}</style>' +
          '<div class="wrap"><button style="position:absolute;left:0;top:5px">+</button>' +
          '<button style="position:absolute;left:0;top:10px">+</button>' +
          '<span style="position:relative">Audit log</span></div>',
      });
      const error = await page
        .act({ type: 'click', target: { nearText: 'Audit log' } })
        .catch((e: { code?: string; message?: string }) => e);
      expect(error.code).toBe('TARGET_AMBIGUOUS');
      expect((error as { message?: string }).message).toContain('button');
    } finally {
      await session?.close();
    }
  });

  it('survives a full act after the minted binding: the revision bump and follow-up ref act work', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await newPage(session);
      const first = await page.act({
        type: 'click',
        target: { nearText: 'Networking', row: true },
      });
      expect(first.newRevision).toBeGreaterThan(first.oldRevision);
      // The near-text click is an ordinary act: observe after it returns fresh
      // refs at the new revision.
      const state = await page.observe({});
      expect(state.revision).toBe(first.newRevision);
      expect(state.elements.some((el) => el.role === 'button')).toBe(true);
    } finally {
      await session?.close();
    }
  });
});
