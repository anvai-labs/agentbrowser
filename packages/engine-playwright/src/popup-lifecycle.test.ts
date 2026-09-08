import type { EngineEvent } from '@agentbrowser/engine';
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
