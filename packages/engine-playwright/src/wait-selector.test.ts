import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

/**
 * F7: selectorVisible rides a native engine primitive. Engines without it
 * degrade at the service boundary (ENGINE_UNSUPPORTED); playwright's is
 * real locator visibility, not a sleep.
 */
describe('engine waitForSelector primitive', () => {
  it('resolves once a late-rendered selector becomes visible', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url:
          'data:text/html,<button onclick="setTimeout(()=>{' +
          "const d=document.createElement('div');d.id='late';d.textContent='here';" +
          'document.body.appendChild(d)},250)' +
          '">Reveal</button>',
      });
      const ref = (await page.observe({})).elements.find((e) => e.role === 'button')?.ref;
      if (!ref) throw new Error('Missing observed button');
      await page.act({ type: 'click', target: { ref } });
      await page.waitForSelector('#late', { timeoutMs: 2000 });
    } finally {
      await engine.close();
    }
  });

  it('throws when the selector never appears within the deadline', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: 'data:text/html,<button>Nothing</button>' });
      const error = await page
        .waitForSelector('#never', { timeoutMs: 250 })
        .catch((e: unknown) => e as { code?: string });
      expect((error as { code?: string }).code).toBe('ACTION_TIMEOUT');
    } finally {
      await engine.close();
    }
  });
});
