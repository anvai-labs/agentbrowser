import { expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

it('verifies one fill without replaying a reverting input or disclosing field values', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const page = await (await engine.createSession({ headless: true })).newPage();
    await page.navigate({
      url: 'data:text/html,<label>Secret<input type="password" oninput="window.writes=(window.writes||0)+1;this.value=\'\'"></label>',
    });
    const ref = (await page.observe({})).elements.find((element) => element.name === 'Secret')?.ref;
    const secret = 'private-value-832';
    const error = await page
      .act({
        type: 'fill',
        target: { ref: ref! },
        value: secret,
        expectValue: secret,
        sensitive: true,
      })
      .catch((error) => error);
    const native = (page as unknown as { backingPage(): import('playwright').Page }).backingPage();
    expect(await native.evaluate(() => (window as unknown as { writes: number }).writes)).toBe(1);
    expect(error).toMatchObject({ code: 'VALUE_MISMATCH', retryable: false });
    expect(`${error.message}${JSON.stringify(error)}`).not.toContain(secret);
  } finally {
    await engine.close();
  }
});

it('returns value-free verification evidence and refuses unsupported readback before writing', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const page = await (await engine.createSession({ headless: true })).newPage();
    await page.navigate({
      url: 'data:text/html,<label>Secret<input type="password"></label><div role="textbox" aria-label="Editor" contenteditable="true">unchanged</div>',
    });
    const secret = 'private-success-832';
    const input = (await page.observe({})).elements.find((element) => element.name === 'Secret');
    const effect = await page.act({
      type: 'fill',
      target: { ref: input!.ref },
      value: secret,
      expectValue: secret,
    });
    expect(effect.result).toEqual({ success: true, verified: true });
    expect(JSON.stringify(effect)).not.toContain(secret);
    const editor = (await page.observe({})).elements.find((element) => element.name === 'Editor');
    await expect(
      page.act({
        type: 'fill',
        target: { ref: editor!.ref },
        value: 'replacement',
        expectValue: 'replacement',
      })
    ).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' });
    const native = (page as unknown as { backingPage(): import('playwright').Page }).backingPage();
    expect(await native.getByRole('textbox', { name: 'Editor' }).textContent()).toBe('unchanged');
  } finally {
    await engine.close();
  }
});
