import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

describe('snapshot-degraded binding', () => {
  it('binds and clicks elements whose aria snapshot cannot stabilize', async () => {
    // 1ms cannot cover the CDP round trip a single snapshot needs, so every
    // per-element snapshot times out into the '' sentinel — the same
    // degradation a perpetually-animating page forces at the default timeout.
    const engine = new PlaywrightChromiumEngine({ snapshotTimeoutMs: 1 });
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<button onclick="document.title=1">Go</button>',
      });
      const state = await page.observe({});
      const bindings = (page as unknown as { bindings: Map<string, { snapshot: string }> })
        .bindings;
      expect(bindings.size).toBeGreaterThan(0);
      for (const binding of bindings.values()) expect(binding.snapshot).toBe('');
      const ref = state.elements.find((element) => element.role === 'button')?.ref;
      if (!ref) throw new Error('Missing button');
      await page.act({ type: 'click', target: { ref } });
      expect((await page.observe({})).title).toBe('1');
    } finally {
      await engine.close();
    }
  });

  it('does not churn revisions when snapshots are degraded', async () => {
    const engine = new PlaywrightChromiumEngine({ snapshotTimeoutMs: 1 });
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<button>Stable</button>',
      });
      const first = await page.observe({});
      const second = await page.observe({});
      expect(second.revision).toBe(first.revision);
    } finally {
      await engine.close();
    }
  });
});

describe('snapshot timeout configuration', () => {
  it('reads AGENTBROWSER_SNAPSHOT_TIMEOUT_MS and falls back to 1000ms', () => {
    const name = 'AGENTBROWSER_SNAPSHOT_TIMEOUT_MS';
    const original = process.env[name];
    try {
      delete process.env[name];
      expect(new PlaywrightChromiumEngine().snapshotTimeoutMs).toBe(1000);
      for (const garbage of ['', 'abc', '-5', '0']) {
        process.env[name] = garbage;
        expect(new PlaywrightChromiumEngine().snapshotTimeoutMs).toBe(1000);
      }
      process.env[name] = '3000';
      expect(new PlaywrightChromiumEngine().snapshotTimeoutMs).toBe(3000);
    } finally {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  });
});

describe('observed node identity', () => {
  it('clicks the second identical button and includes checked controls', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<button onclick="document.title=1">Same</button><button onclick="document.title=2">Same</button><input type=checkbox aria-label=Choice checked>',
      });
      const state = await page.observe({});
      expect(
        state.elements.some((element) => element.role === 'checkbox' && element.name === 'Choice')
      ).toBe(true);
      const ref = state.elements.filter((element) => element.role === 'button')[1]?.ref;
      if (!ref) throw new Error('Missing second button');
      await page.act({ type: 'click', target: { ref } });
      expect((await page.observe({})).title).toBe('2');
    } finally {
      await engine.close();
    }
  });

  it.each(['replace', 'remove', 'reorder', 'rename'])(
    'rejects %s between observation and execution',
    async (mutation) => {
      const engine = new PlaywrightChromiumEngine();
      try {
        const page = await (await engine.createSession({ headless: true })).newPage();
        await page.navigate({
          url: 'data:text/html,<button id=a onclick="document.title=1">Same</button><button id=b onclick="document.title=2">Same</button>',
        });
        const ref = (await page.observe({})).elements.find(
          (element) => element.role === 'button'
        )?.ref;
        if (!ref) throw new Error('Missing button');
        const backing = (
          page as unknown as { backingPage(): import('playwright').Page }
        ).backingPage();
        await backing.evaluate((change) => {
          const original = document.getElementById('a');
          if (!original) throw new Error('Missing node');
          if (change === 'replace') original.replaceWith(original.cloneNode(true));
          if (change === 'remove') original.remove();
          if (change === 'reorder') document.body.append(original);
          if (change === 'rename') original.textContent = 'Different';
        }, mutation);
        await expect(page.act({ type: 'click', target: { ref } })).rejects.toMatchObject({
          code: 'STALE_TARGET',
        });
        expect(await backing.title()).toBe('');
        const observedAgain = await page.observe({});
        expect(observedAgain.elements.some((element) => element.ref === ref)).toBe(false);
      } finally {
        await engine.close();
      }
    }
  );
});
