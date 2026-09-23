import type { EngineError, EnginePage } from '@agentbrowser/engine';
import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

function backingPage(page: EnginePage): Page {
  return (page as unknown as { backingPage(): Page }).backingPage();
}

/**
 * Failure edges around target resolution: a remap heal whose retry target
 * then refuses must surface the retry's own refusal, and a target whose
 * role+name locator stopped matching must be refused as stale before any
 * locator action runs.
 */
describe('remap retry and stale identity refusals', () => {
  it('rethrows the healed target refusal when the remapped control is disabled', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<button onclick="document.title=\'clicked\'">Save</button>',
      });
      const ref = (await page.observe({})).elements.find((el) => el.role === 'button')?.ref;
      if (!ref) throw new Error('Missing observed button');

      await backingPage(page).evaluate(() => {
        const el = document.querySelector('button');
        if (!el) return;
        const replacement = el.cloneNode(true) as HTMLElement;
        replacement.disabled = true;
        el.replaceWith(replacement);
      });

      const error = await page
        .act({ type: 'click', target: { ref }, remap: true })
        .catch((e: unknown) => e);

      // The heal found exactly one role+name match, but acting on it refused:
      // the retry's own typed error is what surfaces, not the stale error.
      expect(error).toMatchObject({ code: 'TARGET_DISABLED', retryable: false });
      expect(await backingPage(page).title()).toBe('');
    } finally {
      await engine.close();
    }
  });

  it('refuses when the connected node no longer matches its observed role and name', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: 'data:text/html,<button>Save</button>' });
      const ref = (await page.observe({})).elements.find((el) => el.role === 'button')?.ref;
      if (!ref) throw new Error('Missing observed button');

      // The node stays connected but its accessible name moved: the observed
      // role+name locator now matches nothing, so identity cannot be confirmed.
      await backingPage(page).evaluate(() => {
        document.querySelector('button')?.setAttribute('aria-label', 'Renamed');
      });

      const error: EngineError = await page
        .act({ type: 'click', target: { ref } })
        .catch((e: unknown) => e as EngineError);

      expect(error).toMatchObject({ code: 'STALE_TARGET', retryable: false });
      expect(error.message).toMatch(/identity or semantic state changed/);
      expect(await backingPage(page).title()).toBe('');
    } finally {
      await engine.close();
    }
  });

  it('preserves the original refusal when the heal re-observe dies with the page', async () => {
    const engine = new PlaywrightChromiumEngine();
    let release = () => {};
    let restore = () => {};
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: 'data:text/html,<button>Save</button>' });
      const ref = (await page.observe({})).elements.find((el) => el.role === 'button')?.ref;
      if (!ref) throw new Error('Missing observed button');

      await backingPage(page).evaluate(() => {
        const el = document.querySelector('button');
        if (el) el.replaceWith(el.cloneNode(true));
      });

      // Pin the existing healing boundary, then close the real browser page.
      // No document-size or host-speed assumption determines whether the race occurs.
      let enter = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observe = page.observe.bind(page);
      const spy = vi.spyOn(page, 'observe').mockImplementationOnce(async (options) => {
        enter();
        await gate;
        return observe(options);
      });
      restore = () => spy.mockRestore();
      const actPromise = page
        .act({ type: 'click', target: { ref }, remap: true })
        .catch((error: unknown) => error as EngineError);
      await Promise.race([
        entered,
        actPromise.then(() => {
          throw new Error('Action settled before entering heal observation');
        }),
      ]);
      await page.close();
      release();

      const error = await actPromise;
      expect(spy).toHaveBeenCalledTimes(1);
      // The actual re-observation of the closed page fails. Surface the refusal
      // which triggered healing, never the raw browser teardown error.
      expect(error).toMatchObject({ code: 'STALE_TARGET', retryable: false });
      expect((error as EngineError).message).toMatch(/detached or replaced/);
      expect((error as { details?: { remapEligible?: boolean } }).details?.remapEligible).toBe(
        true
      );
    } finally {
      release();
      restore();
      await engine.close();
    }
  });
});
