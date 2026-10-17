import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

describe('consumer read recovery (isolated Chromium)', () => {
  it('bounds stalled frame enrichment and preserves the main form and unrelated tab', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      const sibling = await session.newPage();
      await sibling.navigate({ url: 'data:text/html,<button>Unrelated</button>' });
      await page.navigate({
        url: 'data:text/html,<label>Email<input value="draft"></label><iframe srcdoc="<p>Transition</p>"></iframe>',
      });
      const raw = (page as unknown as { backingPage(): Page }).backingPage();
      const frame = raw.frames()[1]!;
      const locator = frame.locator.bind(frame);
      const stalled = vi.spyOn(frame, 'locator').mockImplementation((...args) => {
        const result = locator(...args);
        // Simulates a frame execution context that never services enrichment.
        vi.spyOn(result, 'evaluateAll').mockImplementation(() => new Promise(() => {}));
        return result;
      });
      const before = performance.now();
      const partial = await page.observe({ include: ['formControls'] });
      expect(performance.now() - before).toBeLessThan(5000);
      expect(partial.frameCoverage).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: 'unavailable', reason: 'form-controls scan failed' }),
        ])
      );
      expect(partial.elements.find((e) => e.name === 'Email')?.value).toBe('draft');
      stalled.mockRestore();
      // Human/site removes the verification frame. No challenge automation or reload.
      await raw.locator('iframe').evaluate((node) => node.remove());
      const recovered = await page.observe({ include: ['formControls'] });
      expect(recovered.frameCoverage).toBeUndefined();
      expect(recovered.elements.find((e) => e.name === 'Email')?.value).toBe('draft');
      expect((await sibling.observe({})).elements.some((e) => e.name === 'Unrelated')).toBe(true);
    } finally {
      await engine.close();
    }
  });

  it('rejects a mixed title/DOM transition and allows a fresh observation', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: 'data:text/html,<title>Before</title><button>Before</button>' });
      const raw = (page as unknown as { backingPage(): Page }).backingPage();
      const original = raw.title.bind(raw);
      let reads = 0;
      const changed = vi.spyOn(raw, 'title').mockImplementation(async () => {
        if (++reads === 2)
          await raw.evaluate(() => {
            document.title = 'After';
            document.querySelector('button')!.textContent = 'After';
          });
        return original();
      });
      await expect(page.observe({})).rejects.toMatchObject({
        code: 'STALE_TARGET',
        details: { reason: 'page_changed' },
      });
      changed.mockRestore();
      expect((await page.observe({})).elements.some((e) => e.name === 'After')).toBe(true);
    } finally {
      await engine.close();
    }
  });
});

it('records same-tab navigation commits without OAuth query, fragment or userinfo', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const page = await (await engine.createSession({ headless: true })).newPage();
    const raw = (page as unknown as { backingPage(): Page }).backingPage();
    const seen: import('@agentbrowser/engine').EngineEvent[] = [];
    const pump = (async () => {
      for await (const event of page.events()) seen.push(event);
    })();
    await page.navigate({ url: 'data:text/html,<button>Ready</button>' });
    const frame = raw.mainFrame();
    const url = vi
      .spyOn(frame, 'url')
      .mockReturnValue(
        'https://user:private-password@auth.test/callback?code=private-code&state=private-state#private-token'
      );
    raw.emit('framenavigated', frame);
    await vi.waitFor(() =>
      expect(
        seen.some(
          (event) =>
            event.type === 'page.navigated' && event.data?.url === 'https://auth.test/callback'
        )
      ).toBe(true)
    );
    expect(JSON.stringify(seen.filter((e) => e.type === 'page.navigated'))).not.toContain(
      'private'
    );
    url.mockRestore();
    await page.close();
    await pump;
  } finally {
    await engine.close();
  }
});

it('unchecks a visually clipped native checkbox through its associated visible label exactly once', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const page = await (await engine.createSession({ headless: true })).newPage();
    await page.navigate({
      url: `data:text/html,${encodeURIComponent(`<style>
      input { position:absolute; width:1px; height:1px; clip-path:inset(50%); }
      label { display:block; padding:20px; }
      </style><input type="checkbox" id="choice" checked onchange="document.body.dataset.changes = +(document.body.dataset.changes || 0) + 1">
      <label for="choice"><strong>Preference</strong></label>`)}`,
    });
    const raw = (page as unknown as { backingPage(): Page }).backingPage();
    for (let index = 0; index < 2; index++) {
      const ref = (await page.observe({})).elements.find((e) => e.role === 'checkbox')?.ref;
      expect(ref).toBeDefined();
      await page.act({ type: 'uncheck', target: { ref: ref! } });
    }
    expect(await raw.locator('input').isChecked()).toBe(false);
    expect(await raw.locator('body').getAttribute('data-changes')).toBe('1');
  } finally {
    await engine.close();
  }
});

it('keeps large duplicate-name groups pinned to nodes after reorder', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const page = await (await engine.createSession({ headless: true })).newPage();
    const html = Array.from(
      { length: 320 },
      (_, i) => `<button id="b${i}" onclick="document.body.dataset.selected=this.id">Pick</button>`
    ).join('');
    await page.navigate({ url: `data:text/html,${encodeURIComponent(html)}` });
    const raw = (page as unknown as { backingPage(): Page }).backingPage();
    const lookup = vi.spyOn(Object.getPrototypeOf(raw.locator('body')), 'elementHandles');
    const view = await page.observe({});
    expect(lookup.mock.contexts.filter((locator) => String(locator).includes('Pick'))).toHaveLength(
      1
    );
    lookup.mockRestore();
    const ref = view.elements.filter((e) => e.role === 'button')[3]?.ref;
    expect(ref).toBeDefined();
    await raw.evaluate(() => document.body.prepend(document.getElementById('b3')!));
    await expect(page.act({ type: 'click', target: { ref: ref! } })).rejects.toMatchObject({
      code: 'STALE_TARGET',
    });
    expect(await raw.locator('body').getAttribute('data-selected')).toBeNull();
    const fresh = (await page.observe({})).elements.find((e) => e.role === 'button')?.ref;
    await page.act({ type: 'click', target: { ref: fresh! } });
    expect(await raw.locator('body').getAttribute('data-selected')).toBe('b3');
  } finally {
    await engine.close();
  }
});
