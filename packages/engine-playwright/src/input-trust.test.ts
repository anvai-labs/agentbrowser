import type { Page } from 'playwright';
import { expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

it('distinguishes adapter browser input from explicit DOM event dispatch', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const page = await (await engine.createSession({})).newPage();
    const native = (page as unknown as { page: Page }).page;
    await native.setContent(
      '<button>Continue</button><label>Note<input></label><script>window.seen=[];for(const type of ["click","input","keydown"])document.addEventListener(type,e=>seen.push({type:e.type,trusted:e.isTrusted}));</script>'
    );
    const first = await page.observe({});
    const button = first.elements.find((element) => element.name === 'Continue');
    expect(button).toBeDefined();
    await page.act({ type: 'click', target: { ref: button!.ref } });
    const second = await page.observe({});
    const input = second.elements.find((element) => element.name === 'Note');
    expect(input).toBeDefined();
    await page.act({ type: 'fill', target: { ref: input!.ref }, value: 'ordinary text' });
    await page.act({ type: 'press', key: 'Enter' });
    await native.locator('button').dispatchEvent('click');
    const seen = await native.evaluate(
      () => (window as unknown as { seen: Array<{ type: string; trusted: boolean }> }).seen
    );
    expect(seen).toContainEqual({ type: 'click', trusted: true });
    expect(seen).toContainEqual({ type: 'input', trusted: true });
    expect(seen).toContainEqual({ type: 'keydown', trusted: true });
    expect(seen.at(-1)).toEqual({ type: 'click', trusted: false });
  } finally {
    await engine.close();
  }
});
