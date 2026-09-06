import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

describe('real action wire semantics', () => {
  it('delivers directional scroll and untargeted keyboard input', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({
        url: 'data:text/html,<body style="height:5000px"><input aria-label="Input"></body>',
      });
      // Establish focus explicitly: browser autofocus is scheduled after
      // navigation and is not the contract this keyboard test exercises.
      const input = (await page.observe({ mode: 'interactive' })).elements.find(
        (element) => element.name === 'Input'
      );
      if (!input) throw new Error('Missing fixture input');
      await page.act({ type: 'click', target: { ref: input.ref } });
      await page.act({ type: 'press', key: 'A' });
      expect(
        (await page.observe({ mode: 'interactive' })).elements.some(
          (element) => element.value === 'A'
        )
      ).toBe(true);
      await page.act({ type: 'scroll', direction: 'down', amount: 400 });
      const backing = (
        page as unknown as { backingPage(): import('playwright').Page }
      ).backingPage();
      await expect.poll(() => backing.evaluate(() => scrollY)).toBeGreaterThan(0);
    } finally {
      await engine.close();
    }
  });
});
