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

it('keeps a password field value out of mismatch details even without the sensitive flag', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const page = await (await engine.createSession({ headless: true })).newPage();
    await page.navigate({
      url: 'data:text/html,<label>Pass<input type="password"></label>',
    });
    const ref = (await page.observe({})).elements.find((element) => element.name === 'Pass')?.ref;
    const error = await page
      .act({ type: 'fill', target: { ref: ref! }, value: 'hunter2-secret', expectValue: 'zzz' })
      .catch((error) => error);
    expect(error).toMatchObject({
      code: 'VALUE_MISMATCH',
      retryable: false,
      details: { ref: ref, reads: 2 },
    });
    expect(JSON.stringify(error)).not.toContain('hunter2-secret');
    expect(JSON.stringify(error)).not.toContain('zzz');
  } finally {
    await engine.close();
  }
});

it('re-reads once after settle when async normalization lands late and reports expected and actual for non-sensitive mismatches', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const page = await (await engine.createSession({ headless: true })).newPage();
    // The handler normalizes to uppercase 150ms after the input event, so the
    // first readback races the normalization and the settle re-read wins.
    await page.navigate({
      url: 'data:text/html,<label>Code<input oninput="clearTimeout(window.t);window.t=setTimeout(()=>{this.value=this.value.toUpperCase()},150)"></label>',
    });
    const ref = (await page.observe({})).elements.find((element) => element.name === 'Code')?.ref;
    const late = await page.act({
      type: 'fill',
      target: { ref: ref! },
      value: 'abc',
      expectValue: 'ABC',
    });
    expect(late.result).toEqual({ success: true, verified: true });

    const page2 = await (await engine.createSession({ headless: true })).newPage();
    await page2.navigate({
      url: 'data:text/html,<label>Code<input oninput="this.value=this.value.toUpperCase()"></label>',
    });
    const ref2 = (await page2.observe({})).elements.find((element) => element.name === 'Code')?.ref;
    const error = await page2
      .act({ type: 'fill', target: { ref: ref2! }, value: 'xyz', expectValue: 'zzz' })
      .catch((error) => error);
    expect(error).toMatchObject({
      code: 'VALUE_MISMATCH',
      retryable: false,
      details: { ref: ref2, expected: 'zzz', actual: 'XYZ', reads: 2 },
    });
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
