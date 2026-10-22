import { errors } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';
import { backingPage, interceptSnapshots } from './test-support/backing-page.js';

afterEach(() => vi.restoreAllMocks());

describe('refusal diagnostics', () => {
  it('details an unbindable stale target with ref, revision, role and name', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<button onclick="document.title=1">Continue</button>',
      });
      interceptSnapshots(page, () => {
        throw new errors.TimeoutError('Injected total snapshot failure');
      });
      const ref = (await page.observe({})).elements.find(
        (element) => element.role === 'button'
      )?.ref;
      if (!ref) throw new Error('Missing observed button');
      await expect(page.act({ type: 'click', target: { ref } })).rejects.toMatchObject({
        code: 'STALE_TARGET',
        retryable: true,
        // The DOM-only fallback that minted this ref knows the role but not
        // the accessible name, so details carry exactly what is known.
        details: { ref, role: 'button', revision: expect.any(Number) },
      });
    } finally {
      await engine.close();
    }
  });

  it('details a detached-target refusal with the observed identity', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<button onclick="document.title=1">Vanish</button>',
      });
      const ref = (await page.observe({})).elements.find(
        (element) => element.role === 'button'
      )?.ref;
      if (!ref) throw new Error('Missing observed button');
      await backingPage(page).evaluate(() => {
        document.querySelector('button')?.remove();
      });
      await expect(page.act({ type: 'click', target: { ref } })).rejects.toMatchObject({
        code: 'STALE_TARGET',
        details: { ref, role: 'button', name: 'Vanish', revision: expect.any(Number) },
      });
    } finally {
      await engine.close();
    }
  });

  it('details TARGET_NOT_FOUND for unknown refs', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: 'data:text/html,<button>Go</button>' });
      await page.observe({});
      await expect(page.resolve({ ref: 'e999999_999' })).rejects.toMatchObject({
        code: 'TARGET_NOT_FOUND',
        details: { ref: 'e999999_999', revision: expect.any(Number) },
      });
    } finally {
      await engine.close();
    }
  });
});
