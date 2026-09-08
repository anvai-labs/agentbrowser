import type { EnginePage } from '@agentbrowser/engine';
import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

/**
 * Playwright exports Locator/ElementHandle shapes as types only, so spies
 * attach to the prototype of a live instance (same pattern as
 * target-identity.test.ts).
 */
function locatorPrototype(page: EnginePage): Locator {
  const backing = (page as unknown as { backingPage(): Page }).backingPage();
  return Object.getPrototypeOf(backing.locator('body')) as Locator;
}

/**
 * F9: link elements carry their destination captured at observation time,
 * capped at 2048 chars. The capture is additive metadata: it must never
 * perturb revision/evidence machinery.
 */
describe('observe link hrefs', () => {
  it('captures hrefs on links and nothing on non-links', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<a href="https://example.com/docs">Docs</a><button>OK</button>',
      });
      const { elements } = await page.observe({});
      const link = elements.find((e) => e.role === 'link');
      const button = elements.find((e) => e.role === 'button');
      expect(link?.href).toBe('https://example.com/docs');
      expect(link?.hrefTruncated).toBeUndefined();
      expect(button?.href).toBeUndefined();
    } finally {
      await engine.close();
    }
  });

  it('caps hrefs at 2048 characters and flags the truncation', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      const long = `https://example.com/${'a'.repeat(3000)}`;
      await page.navigate({ url: `data:text/html,<a href="${long}">Long</a>` });
      const { elements } = await page.observe({});
      const link = elements.find((e) => e.role === 'link');
      expect(link?.href?.length).toBe(2048);
      expect(link?.hrefTruncated).toBe(true);
    } finally {
      await engine.close();
    }
  });

  it('tolerates a failing href capture without dropping the element', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<a href="https://example.com/a">A</a><a href="https://example.com/b">B</a>',
      });
      vi.spyOn(locatorPrototype(page), 'getAttribute').mockRejectedValueOnce(
        new Error('capture failed')
      );
      const { elements } = await page.observe({});
      const links = elements.filter((e) => e.role === 'link');
      expect(links).toHaveLength(2);
      expect(links[0]?.href).toBeUndefined();
      expect(links[1]?.href).toBe('https://example.com/b');
    } finally {
      vi.restoreAllMocks();
      await engine.close();
    }
  });

  it('does not perturb revision machinery across repeated observes', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: 'data:text/html,<a href="https://example.com/">Home</a>' });
      const first = await page.observe({});
      const second = await page.observe({});
      expect(second.revision).toBe(first.revision);
      expect(second.elements[0]?.href).toBe('https://example.com/');
    } finally {
      await engine.close();
    }
  });
});
