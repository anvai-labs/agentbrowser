import type { EngineEvent } from '@agentbrowser/engine';
import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

/**
 * F10: window.open popups are adopted by the engine - session.pages()
 * reports them and the opener's event stream announces page.created, which
 * the service consumes to auto-register the popup with its opener.
 */
describe('popup lifecycle (real Chromium)', () => {
  it('adopts a window.open popup and announces page.created on the opener', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const opener = await session.newPage();
      await opener.navigate({
        url: 'data:text/html,<button id="pop" onclick="window.open(\'about:blank\',\'_blank\')">Open</button>',
      });

      const seen: EngineEvent[] = [];
      const pump = (async () => {
        for await (const event of opener.events()) {
          seen.push(event);
        }
      })().catch(() => {});

      const ref = (await opener.observe({})).elements.find((e) => e.role === 'button')?.ref;
      if (!ref) throw new Error('Missing observed button');
      await opener.act({ type: 'click', target: { ref } });

      await vi.waitFor(async () => {
        if ((await session.pages()).length < 2) {
          throw new Error('popup not adopted yet');
        }
      });
      const popup = (await session.pages()).find((page) => page.id !== opener.id);
      expect(popup).toBeDefined();

      await vi.waitFor(() => {
        if (!seen.some((event) => event.type === 'page.created')) {
          throw new Error('no page.created yet');
        }
      });
      const event = seen.find((candidate) => candidate.type === 'page.created');
      expect(event?.data).toMatchObject({ openerPageId: opener.id, pageId: popup?.id });

      await opener.close().catch(() => {});
      await pump;
    } finally {
      await engine.close();
    }
  });
});

it('handles an immediate-close popup without leaving a phantom page or hanging its stream', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const session = await engine.createSession({ headless: true });
    const opener = await session.newPage();
    const internal = session as unknown as { adoptPopupPage(page: Page): Promise<void> };
    const adopt = internal.adoptPopupPage.bind(internal);
    const adoptions: Promise<void>[] = [];
    vi.spyOn(internal, 'adoptPopupPage').mockImplementation((page) => {
      const task = adopt(page);
      adoptions.push(task);
      return task;
    });
    await opener.navigate({
      url: `data:text/html,${encodeURIComponent('<button onclick="const child=window.open(\'about:blank\'); child.close()">Open briefly</button>')}`,
    });
    const seen: EngineEvent[] = [];
    const pump = (async () => {
      for await (const event of opener.events()) seen.push(event);
    })();
    const ref = (await opener.observe({})).elements.find((e) => e.role === 'button')?.ref;
    expect(ref).toBeDefined();
    await opener.act({ type: 'click', target: { ref: ref! } });
    await vi.waitFor(() => expect(adoptions).toHaveLength(1));
    await Promise.all(adoptions);
    await vi.waitFor(async () => expect(await session.pages()).toHaveLength(1));
    // A popup adopted while live is announced; one already closed before
    // adoption is not. The live-popup test above requires its creation event.
    expect(seen.filter((event) => event.type === 'page.created').length).toBeLessThanOrEqual(1);
    await opener.close();
    await pump;
  } finally {
    await engine.close();
  }
});
