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
    const input = view.elements.find((e) => e.name === 'Company' && e.role === 'textbox')!;
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

const ownedPopupFixture = `
  <fieldset id="company-block"><legend>Company</legend>
    <input id="company" role="combobox" aria-label="Company" aria-controls="company-list">
  </fieldset>
  <input id="other" role="combobox" aria-label="Other" aria-controls="other-list">
  <div role="listbox" id="company-list"><div role="option" onclick="this.dataset.clicked='true'">Exact</div></div>
  <div role="listbox" id="other-list"><div role="option" onclick="this.dataset.clicked='true'">Exact</div></div>
`;

async function withOwnedPopup(
  test: (page: EnginePage, backing: import('playwright').Page) => Promise<void>
) {
  const engine = new PlaywrightChromiumEngine();
  try {
    const session = await engine.createSession({ headless: true });
    const page = await session.newPage();
    const backing = (
      page as EnginePage & { backingPage(): import('playwright').Page }
    ).backingPage();
    await backing.setContent(ownedPopupFixture);
    await backing.locator('#company').focus();
    await test(page, backing);
  } finally {
    await engine.close();
  }
}

it('captures unique portaled popup ownership independently of the control fieldset', async () => {
  await withOwnedPopup(async (page) => {
    const view = await page.observe({ include: ['formControls'] });
    const control = view.elements.find((e) => e.name === 'Company' && e.role === 'combobox')!;
    const other = view.elements.find((e) => e.name === 'Other')!;
    const options = view.elements.filter((e) => e.role === 'option');
    expect(control.attributes).toMatchObject({
      'autofill-popup-state': 'ready',
      'autofill-focused': 'true',
    });
    expect(options).toHaveLength(2);
    expect(options[0]!.attributes).toMatchObject({
      'autofill-popup': control.attributes!['autofill-popup'],
      'autofill-owner': control.attributes!['autofill-node'],
      'autofill-owner-focused': 'true',
      'autofill-popup-state': 'ready',
      'autofill-block': '',
    });
    expect(options[1]!.attributes!['autofill-owner']).toBe(other.attributes!['autofill-node']);
    expect(options[1]!.attributes!['autofill-popup']).not.toBe(
      control.attributes!['autofill-popup']
    );
    await page.act({ type: 'click', target: { ref: options[0]!.ref } });
  });
});

it.each([
  'duplicate-id',
  'multiple-owners',
  'multiple-popups',
  'missing-owner',
  'overlong-owner',
  'too-many-owner-refs',
])('does not publish ownership for %s', async (mutation) => {
  await withOwnedPopup(async (page, backing) => {
    await backing.evaluate((kind) => {
      const control = document.getElementById('company')!;
      if (kind === 'duplicate-id') {
        const duplicate = document.createElement('div');
        duplicate.id = 'company-list';
        document.body.append(duplicate);
      } else if (kind === 'multiple-owners') {
        document.getElementById('other')!.setAttribute('aria-controls', 'company-list');
      } else if (kind === 'multiple-popups') {
        control.setAttribute('aria-controls', 'company-list other-list');
      } else if (kind === 'overlong-owner') {
        document
          .getElementById('other')!
          .setAttribute('aria-controls', `${'x'.repeat(1025)} company-list`);
      } else if (kind === 'too-many-owner-refs') {
        document
          .getElementById('other')!
          .setAttribute(
            'aria-controls',
            `${Array.from({ length: 32 }, (_, i) => `missing${i}`).join(' ')} company-list`
          );
      } else control.removeAttribute('aria-controls');
    }, mutation);
    const view = await page.observe({ include: ['formControls'] });
    const option = view.elements.find((e) => e.role === 'option')!;
    expect(option.attributes?.['autofill-popup-state']).toBe('invalid');
    expect(option.attributes?.['autofill-owner']).toBeUndefined();
    expect(option.attributes?.['autofill-popup']).toBeUndefined();
    if (mutation === 'missing-owner') {
      const control = view.elements.find((e) => e.name === 'Company' && e.role === 'combobox');
      expect(control?.attributes?.['autofill-popup-state']).toBe('pending');
      expect(control?.attributes?.['autofill-popup']).toBeUndefined();
    }
  });
});

it('keeps a declared unmounted popup pending until its unique listbox appears', async () => {
  await withOwnedPopup(async (page, backing) => {
    await backing.locator('#company-list').evaluate((node) => node.remove());
    const pending = await page.observe({ include: ['formControls'] });
    const control = pending.elements.find((e) => e.name === 'Company' && e.role === 'combobox');
    expect(control?.attributes?.['autofill-popup-state']).toBe('pending');
    expect(control?.attributes?.['autofill-popup']).toBeUndefined();
    await backing.evaluate(() => {
      const popup = document.createElement('div');
      popup.id = 'company-list';
      popup.setAttribute('role', 'listbox');
      popup.innerHTML = '<div role="option">Mounted option</div>';
      document.body.append(popup);
    });
    const ready = await page.observe({ include: ['formControls'] });
    const updated = ready.elements.find((e) => e.name === 'Company' && e.role === 'combobox');
    const option = ready.elements.find((e) => e.role === 'option' && e.name === 'Mounted option');
    expect(updated?.attributes?.['autofill-node']).toBe(control?.attributes?.['autofill-node']);
    expect(updated?.attributes?.['autofill-popup-state']).toBe('ready');
    expect(option?.attributes).toMatchObject({
      'autofill-popup-state': 'ready',
      'autofill-popup': updated?.attributes?.['autofill-popup'],
      'autofill-owner': updated?.attributes?.['autofill-node'],
    });
  });
});

it.each([
  'ownership-change',
  'option-reparent',
  'focus-theft',
  'popup-replace',
  'owner-block-move',
  'owner-disabled',
  'owner-hidden',
  'owner-match-change',
])('refuses option dispatch after %s with no click effect', async (mutation) => {
  await withOwnedPopup(async (page, backing) => {
    const view = await page.observe({ include: ['formControls'] });
    const option = view.elements.find((e) => e.role === 'option')!;
    await backing.evaluate((kind) => {
      const popup = document.getElementById('company-list')!;
      if (kind === 'ownership-change') {
        document.getElementById('company')!.setAttribute('aria-controls', 'other-list');
      } else if (kind === 'option-reparent') {
        document.getElementById('other-list')!.append(popup.firstElementChild!);
      } else if (kind === 'focus-theft') {
        document.getElementById('other')!.focus();
      } else if (kind === 'owner-block-move') {
        const destination = document.createElement('fieldset');
        document.body.append(destination);
        destination.append(document.getElementById('company')!);
        document.getElementById('company')!.focus();
      } else if (kind === 'owner-disabled') {
        document.getElementById('company')!.setAttribute('aria-disabled', 'true');
      } else if (kind === 'owner-hidden') {
        document.getElementById('company')!.style.opacity = '0';
        document.getElementById('company')!.style.visibility = 'hidden';
      } else if (kind === 'owner-match-change') {
        document.getElementById('company')!.setAttribute('data-automation-id', 'other-field');
      } else {
        const replacement = popup.cloneNode(false);
        replacement.appendChild(popup.firstElementChild!);
        popup.replaceWith(replacement);
      }
    }, mutation);
    await expect(page.act({ type: 'click', target: { ref: option.ref } })).rejects.toMatchObject({
      code: 'STALE_TARGET',
    });
    expect(await backing.locator('[data-clicked]').count()).toBe(0);
  });
});

it('publishes pending readiness until the unique popup becomes visible', async () => {
  await withOwnedPopup(async (page, backing) => {
    await backing.locator('#company-list').evaluate((node) => {
      node.style.display = 'none';
    });
    const pending = await page.observe({ include: ['formControls'] });
    expect(
      pending.elements.find((e) => e.name === 'Company' && e.role === 'combobox')?.attributes
    ).toMatchObject({
      'autofill-popup-state': 'pending',
      'autofill-focused': 'true',
    });
    await backing.locator('#company-list').evaluate((node) => {
      node.style.display = '';
    });
    const ready = await page.observe({ include: ['formControls'] });
    expect(
      ready.elements.find((e) => e.name === 'Company' && e.role === 'combobox')?.attributes?.[
        'autofill-popup-state'
      ]
    ).toBe('ready');
  });
});
