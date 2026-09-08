import type { EnginePage } from '@agentbrowser/engine';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

function backingPage(page: EnginePage): Page {
  return (page as unknown as { backingPage(): Page }).backingPage();
}

describe('action timeout diagnostics', () => {
  it('reports the occluding element when a click times out', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url:
          'data:text/html,<div style="position:fixed;inset:0;z-index:10"></div>' +
          '<button style="position:fixed;top:20px;left:20px" onclick="document.title=\'x\'">Blocked</button>',
      });
      backingPage(page).setDefaultTimeout(400);
      const ref = (await page.observe({})).elements.find((e) => e.role === 'button')?.ref;
      if (!ref) throw new Error('Missing observed button');
      const error = await page.act({ type: 'click', target: { ref } }).catch((e: unknown) => e);
      await expect(error).toMatchObject({
        code: 'ACTION_TIMEOUT',
        details: { ref, blockedBy: { tag: 'div' } },
      });
      expect(await backingPage(page).title()).toBe('');
    } finally {
      await engine.close();
    }
  });

  it('reports no blocker when the hit test has nothing to report', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<button style="position:fixed;left:-9999px" onclick="document.title=\'x\'">Offscreen</button>',
      });
      backingPage(page).setDefaultTimeout(400);
      const ref = (await page.observe({})).elements.find((e) => e.role === 'button')?.ref;
      if (!ref) throw new Error('Missing observed button');
      const error = await page.act({ type: 'click', target: { ref } }).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe('ACTION_TIMEOUT');
      expect((error as { details?: { blockedBy?: unknown } }).details?.blockedBy).toBeUndefined();
    } finally {
      await engine.close();
    }
  });
});
