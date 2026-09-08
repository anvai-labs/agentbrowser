import type { EnginePage } from '@agentbrowser/engine';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

function backingPage(page: EnginePage): Page {
  return (page as unknown as { backingPage(): Page }).backingPage();
}

async function observeButton(page: EnginePage): Promise<string> {
  const ref = (await page.observe({})).elements.find((e) => e.role === 'button')?.ref;
  if (!ref) throw new Error('Missing observed button');
  return ref;
}

const SIMPLE_BUTTON = 'data:text/html,<button onclick="document.title=\'clicked\'">Save</button>';

/**
 * F2: remap is OPT-IN healing for replaced controls. resolve() fails before
 * any locator action runs, so a remap retry cannot double-fire; live
 * semantic-evidence mismatches are never eligible.
 */
describe('opt-in remap', () => {
  it('remaps a replaced control and reports the span when opted in', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: SIMPLE_BUTTON });
      const ref = await observeButton(page);
      await backingPage(page).evaluate(() => {
        const el = document.querySelector('button');
        if (el) el.replaceWith(el.cloneNode(true));
      });

      const effect = await page.act({ type: 'click', target: { ref }, remap: true });

      expect(effect.remap).toEqual({ from: ref, to: expect.any(String) });
      expect(effect.remap?.to).not.toBe(ref);
      expect(await backingPage(page).title()).toBe('clicked');
    } finally {
      await engine.close();
    }
  });

  it('still refuses a replaced control by default', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: SIMPLE_BUTTON });
      const ref = await observeButton(page);
      await backingPage(page).evaluate(() => {
        const el = document.querySelector('button');
        if (el) el.replaceWith(el.cloneNode(true));
      });

      const error = await page.act({ type: 'click', target: { ref } }).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'STALE_TARGET' });
      expect(await backingPage(page).title()).toBe('');
    } finally {
      await engine.close();
    }
  });

  it('refuses with candidates 0 when the control is gone', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: SIMPLE_BUTTON });
      const ref = await observeButton(page);
      await backingPage(page).evaluate(() => document.querySelector('button')?.remove());

      const error = await page
        .act({ type: 'click', target: { ref }, remap: true })
        .catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: 'STALE_TARGET',
        details: { ref, candidates: 0 },
      });
    } finally {
      await engine.close();
    }
  });

  it('refuses a renamed replacement rather than guessing', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: SIMPLE_BUTTON });
      const ref = await observeButton(page);
      await backingPage(page).evaluate(() => {
        const el = document.querySelector('button');
        if (!el) return;
        const clone = el.cloneNode(true);
        clone.textContent = 'Renamed';
        el.replaceWith(clone);
      });

      const error = await page
        .act({ type: 'click', target: { ref }, remap: true })
        .catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'STALE_TARGET', details: { candidates: 0 } });
      expect(await backingPage(page).title()).toBe('');
    } finally {
      await engine.close();
    }
  });

  it('refuses ambiguous candidates rather than guessing', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: SIMPLE_BUTTON });
      const ref = await observeButton(page);
      await backingPage(page).evaluate(() => {
        const el = document.querySelector('button');
        if (!el) return;
        el.replaceWith(el.cloneNode(true));
        const second = el.cloneNode(true);
        document.body.appendChild(second);
      });

      const error = await page
        .act({ type: 'click', target: { ref }, remap: true })
        .catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'STALE_TARGET', details: { candidates: 2 } });
      expect(await backingPage(page).title()).toBe('');
    } finally {
      await engine.close();
    }
  });

  it('leaves non-targeted actions alone even with remap set', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      const effect = await page.act({
        type: 'navigate',
        url: SIMPLE_BUTTON,
        remap: true,
      });
      expect(effect.remap).toBeUndefined();
      expect((await page.getUrl()).startsWith('data:text/html')).toBe(true);
    } finally {
      await engine.close();
    }
  });
});
