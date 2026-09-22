import type { EnginePage } from '@agentbrowser/engine';
import type { Locator, Page } from 'playwright';
import { expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

const native = (page: EnginePage) => (page as unknown as { backingPage(): Page }).backingPage();
it('reads native document bytes without AX binding and preserves previously observed refs', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const page = await (await engine.createSession({ headless: true })).newPage();
    await page.navigate({
      url: `data:text/html,${encodeURIComponent(
        '<!DOCTYPE html><html><head><title>Source</title></head><body><p>λ &amp; text</p><button onclick="document.title=\'Clicked\'">Go</button></body></html>'
      )}`,
    });
    const observed = await page.observe({});
    const ref = observed.elements.find((element) => element.role === 'button')?.ref;
    if (!ref || !page.readDocument) throw new Error('Document port or button missing');
    const browser = native(page);
    const prototype = Object.getPrototypeOf(browser.locator('body')) as Locator;
    const aria = vi.spyOn(prototype, 'ariaSnapshot').mockRejectedValue(new Error('AX unavailable'));
    try {
      const document = await page.readDocument();
      expect(document).toEqual({
        url: browser.url(),
        title: 'Source',
        content: await browser.content(),
      });
      expect(aria).not.toHaveBeenCalled();
    } finally {
      aria.mockRestore();
    }
    await page.act({ type: 'click', target: { ref } });
    expect(await browser.title()).toBe('Clicked');
    await page.close();
    await expect(page.readDocument()).rejects.toThrow();
  } finally {
    await engine.close();
  }
}, 30000);

it('captures all source links on a large index without constructing actionable refs', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const page = await (await engine.createSession({ headless: true })).newPage();
    const html = `<!DOCTYPE html><title>Index</title>${Array.from(
      { length: 1200 },
      (_, i) => `<a href="https://example.com/job/${i}">Job ${i}</a>`
    ).join('')}`;
    await native(page).setContent(html);
    if (!page.readDocument) throw new Error('Missing document port');
    const prototype = Object.getPrototypeOf(native(page).locator('body')) as Locator;
    const aria = vi
      .spyOn(prototype, 'ariaSnapshot')
      .mockRejectedValue(new Error('AX must not run'));
    try {
      const captured = await page.readDocument();
      expect(captured.content.match(/<a /g)).toHaveLength(1200);
      expect(captured.content).toBe(await native(page).content());
      expect(aria).not.toHaveBeenCalled();
      await expect(page.resolve({ ref: 'e0_0' })).rejects.toThrow();
    } finally {
      aria.mockRestore();
    }
  } finally {
    await engine.close();
  }
}, 30000);
