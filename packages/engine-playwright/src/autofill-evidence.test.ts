import type { EnginePage } from '@agentbrowser/engine';
import { expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

it('refuses a control moved into another fieldset after observation', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const session = await engine.createSession({ headless: true });
    const page = await session.newPage();
    await page.navigate({
      url: 'data:text/html,<fieldset id="a"><legend>A</legend><input aria-label="Company"></fieldset><fieldset id="b"><legend>B</legend></fieldset>',
    });
    const view = await page.observe({ include: ['formControls'] });
    const input = view.elements.find((e) => e.name === 'Company')!;
    const backing = (
      page as EnginePage & { backingPage(): import('playwright').Page }
    ).backingPage();
    await backing.evaluate(() =>
      document.getElementById('b')!.append(document.querySelector('input')!)
    );
    await expect(
      page.act({ type: 'fill', target: { ref: input.ref }, value: 'wrong block' })
    ).rejects.toMatchObject({ code: 'STALE_TARGET' });
    expect(await backing.locator('input').inputValue()).toBe('');
  } finally {
    await engine.close();
  }
});
