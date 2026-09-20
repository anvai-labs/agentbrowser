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

it('marks oversized React Select-style commitment evidence incomplete without truncating', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const session = await engine.createSession({ headless: true });
    const page = await session.newPage();
    const backing = (
      page as EnginePage & { backingPage(): import('playwright').Page }
    ).backingPage();
    await backing.setContent(`
      <label for="single">Single</label>
      <div class="select__value-container"><div id="single-value" class="select__single-value"></div><input id="single" role="combobox" aria-autocomplete="list"></div>
      <label for="long-chip">Long chip</label>
      <div id="long-container" class="select__value-container"><input id="long-chip" role="combobox" aria-autocomplete="list"></div>
      <label for="escaped-chips">Escaped chips</label>
      <div id="escaped-container" class="select__value-container"><input id="escaped-chips" role="combobox" aria-autocomplete="list"></div>
    `);
    await backing.evaluate(
      ({ overlong, escaped }) => {
        const add = (containerId: string, values: string[]) => {
          const container = document.getElementById(containerId);
          if (!container) throw new Error('fixture container missing');
          for (const value of values) {
            const label = document.createElement('div');
            label.className = 'select__multi-value__label';
            label.textContent = value;
            container.prepend(label);
          }
        };
        const single = document.getElementById('single-value');
        if (!single) throw new Error('fixture single value missing');
        single.textContent = overlong;
        add('long-container', [overlong]);
        add(
          'escaped-container',
          Array.from({ length: 32 }, () => escaped)
        );
      },
      { overlong: 'x'.repeat(513), escaped: '"'.repeat(256) }
    );

    const view = await page.observe({ include: ['formControls'] });
    const evidence = (name: string) => {
      const attributes = view.elements.find((element) => element.name === name)?.attributes;
      expect(attributes).toBeDefined();
      return attributes ?? {};
    };
    expect(evidence('Single')['autofill-committed']).toBeUndefined();
    expect(evidence('Long chip')).toMatchObject({
      'autofill-committed-members-complete': 'false',
    });
    expect(evidence('Long chip')['autofill-committed-members']).toBeUndefined();
    expect(evidence('Escaped chips')).toMatchObject({
      'autofill-committed-members-complete': 'false',
    });
    expect(evidence('Escaped chips')['autofill-committed-members']).toBeUndefined();
  } finally {
    await engine.close();
  }
});
