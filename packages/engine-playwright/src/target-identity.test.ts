import type { EnginePage } from '@agentbrowser/engine';
import { type Locator, type Page, errors } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

afterEach(() => vi.restoreAllMocks());

function backingPage(page: EnginePage): Page {
  return (page as unknown as { backingPage(): Page }).backingPage();
}

function interceptSnapshots(
  page: EnginePage,
  capture: (kind: 'body' | 'element', options: { timeout?: number }) => void
) {
  const body = backingPage(page).locator('body');
  const prototype = Object.getPrototypeOf(body) as Locator;
  const original = prototype.ariaSnapshot;
  return vi.spyOn(prototype, 'ariaSnapshot').mockImplementation(async function (
    this: Locator,
    options = {}
  ) {
    capture(this.toString() === body.toString() ? 'body' : 'element', options);
    return original.call(this, options);
  });
}

function degradeElements(page: EnginePage) {
  return interceptSnapshots(page, (kind) => {
    if (kind === 'element') throw new errors.TimeoutError('Injected element timeout');
  });
}

describe('snapshot-degraded binding', () => {
  it('returns retryable staleness for a named observed control without any snapshot evidence', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<button onclick="document.title=1">Continue</button>',
      });
      interceptSnapshots(page, () => {
        throw new errors.TimeoutError('Injected total snapshot failure');
      });
      const ref = (await page.observe({})).elements.find(
        (element) => element.role === 'button'
      )?.ref;
      if (!ref) throw new Error('Missing observed button');
      await expect(page.act({ type: 'click', target: { ref } })).rejects.toMatchObject({
        code: 'STALE_TARGET',
        retryable: true,
      });
      expect(await backingPage(page).title()).toBe('');
      await expect(page.resolve({ ref: 'e999999_999' })).rejects.toMatchObject({
        code: 'TARGET_NOT_FOUND',
      });
    } finally {
      await engine.close();
    }
  });

  it('validates document evidence before clicking an element whose snapshot times out', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<button onclick="document.title=1">Go</button>',
      });
      degradeElements(page);
      const state = await page.observe({});
      const bindings = (
        page as unknown as {
          bindings: Map<string, { snapshot?: string; documentSnapshot?: string }>;
        }
      ).bindings;
      expect(bindings.size).toBeGreaterThan(0);
      for (const binding of bindings.values()) {
        expect(binding.snapshot).toBeUndefined();
        expect(binding.documentSnapshot).toMatch(/^[a-f0-9]{64}$/);
      }
      const ref = state.elements.find((element) => element.role === 'button')?.ref;
      if (!ref) throw new Error('Missing button');
      await page.act({ type: 'click', target: { ref } });
      expect((await page.observe({})).title).toBe('1');
    } finally {
      await engine.close();
    }
  });

  it('does not churn revisions across unchanged document/element evidence transitions', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<button>Stable</button>',
      });
      const first = await page.observe({});
      const spy = degradeElements(page);
      expect((await page.observe({})).revision).toBe(first.revision);
      expect((await page.observe({})).revision).toBe(first.revision);
      spy.mockRestore();
      expect((await page.observe({})).revision).toBe(first.revision);
    } finally {
      await engine.close();
    }
  });

  it.each(['checked', 'pressed', 'destination'])(
    'rejects a same-node %s change under document fallback',
    async (change) => {
      const engine = new PlaywrightChromiumEngine();
      try {
        const page = await (await engine.createSession({ headless: true })).newPage();
        await page.navigate({
          url: 'data:text/html,<input id=target type=checkbox aria-label=Confirm onclick="document.title=1"><button aria-pressed=false>Press</button><a href="https://example.com/a" onclick="event.preventDefault();document.title=1">Go</a>',
        });
        const spy = degradeElements(page);
        const state = await page.observe({});
        const role = change === 'checked' ? 'checkbox' : change === 'pressed' ? 'button' : 'link';
        const ref = state.elements.find((element) => element.role === role)?.ref;
        if (!ref) throw new Error('Missing target');
        await backingPage(page).evaluate((mutation) => {
          if (mutation === 'checked')
            (document.querySelector('input') as HTMLInputElement).checked = true;
          if (mutation === 'pressed')
            document.querySelector('button')?.setAttribute('aria-pressed', 'true');
          if (mutation === 'destination')
            document.querySelector('a')?.setAttribute('href', 'https://example.com/b');
        }, change);
        await expect(page.act({ type: 'click', target: { ref } })).rejects.toMatchObject({
          code: 'STALE_TARGET',
        });
        expect(await backingPage(page).title()).toBe('');
        spy.mockRestore();
        expect((await page.observe({})).revision).toBeGreaterThan(state.revision);
      } finally {
        await engine.close();
      }
    }
  );

  it('invalidates changed element evidence when the next observation uses document evidence', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: 'data:text/html,<button aria-pressed=false>Press</button>' });
      const first = await page.observe({});
      await backingPage(page).evaluate(() =>
        document.querySelector('button')?.setAttribute('aria-pressed', 'true')
      );
      degradeElements(page);
      const second = await page.observe({});
      expect(second.revision).toBeGreaterThan(first.revision);
      expect(second.elements[0]?.ref).not.toBe(first.elements[0]?.ref);
    } finally {
      await engine.close();
    }
  });

  it('releases a newly registered handle when snapshot capture fails', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: 'data:text/html,<button>Go</button>' });
      const error = new Error('Injected snapshot transport failure');
      let disposeCalls = 0;
      const bindings = () =>
        (
          page as unknown as {
            bindings: Map<string, { handle: { dispose(): Promise<void> } }>;
          }
        ).bindings;
      interceptSnapshots(page, (kind) => {
        if (kind !== 'element') return;
        const handle = [...bindings().values()][0]?.handle;
        if (!handle) throw new Error('Handle not registered');
        const dispose = handle.dispose.bind(handle);
        vi.spyOn(handle, 'dispose').mockImplementation(async () => {
          disposeCalls += 1;
          await dispose();
        });
        throw error;
      });
      await expect(page.observe({})).rejects.toBe(error);
      expect(bindings().size).toBe(0);
      expect(disposeCalls).toBe(1);
    } finally {
      await engine.close();
    }
  });

  it.each(['timeout', 'transport'])(
    'rejects a fresh %s failure after successful element evidence',
    async (failure) => {
      const engine = new PlaywrightChromiumEngine();
      try {
        const page = await (await engine.createSession({ headless: true })).newPage();
        await page.navigate({
          url: 'data:text/html,<button onclick="document.title=1">Go</button>',
        });
        const ref = (await page.observe({})).elements.find(
          (element) => element.role === 'button'
        )?.ref;
        if (!ref) throw new Error('Missing button');
        interceptSnapshots(page, (kind) => {
          if (kind !== 'element') return;
          if (failure === 'timeout') throw new errors.TimeoutError('Injected snapshot timeout');
          throw new Error('Injected snapshot transport failure');
        });
        await expect(page.act({ type: 'click', target: { ref } })).rejects.toMatchObject({
          code: failure === 'timeout' ? 'ACTION_TIMEOUT' : 'INTERNAL',
        });
        expect(await backingPage(page).title()).toBe('');
      } finally {
        await engine.close();
      }
    }
  );

  it.each(['body', 'element'] as const)(
    'does not suppress unrelated %s capture failures',
    async (scope) => {
      const engine = new PlaywrightChromiumEngine();
      try {
        const page = await (await engine.createSession({ headless: true })).newPage();
        await page.navigate({ url: 'data:text/html,<button>Go</button>' });
        const error = new Error('Injected transport failure');
        interceptSnapshots(page, (kind) => {
          if (kind === scope) throw error;
        });
        await expect(page.observe({})).rejects.toBe(error);
      } finally {
        await engine.close();
      }
    }
  );

  it.each(['timeout', 'transport'])(
    'rejects fresh document %s failures for fallback bindings',
    async (failure) => {
      const engine = new PlaywrightChromiumEngine();
      try {
        const page = await (await engine.createSession({ headless: true })).newPage();
        await page.navigate({
          url: 'data:text/html,<button onclick="document.title=1">Go</button>',
        });
        const spy = degradeElements(page);
        const ref = (await page.observe({})).elements.find(
          (element) => element.role === 'button'
        )?.ref;
        if (!ref) throw new Error('Missing button');
        spy.mockRestore();
        interceptSnapshots(page, (kind) => {
          if (kind !== 'body') return;
          if (failure === 'timeout') throw new errors.TimeoutError('Injected snapshot timeout');
          throw new Error('Injected transport failure');
        });
        await expect(page.act({ type: 'click', target: { ref } })).rejects.toMatchObject({
          code: failure === 'timeout' ? 'ACTION_TIMEOUT' : 'INTERNAL',
        });
        expect(await backingPage(page).title()).toBe('');
      } finally {
        await engine.close();
      }
    }
  );

  it('refuses actions and invalidates refs when no semantic evidence is available', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: 'data:text/html,<button onclick="document.title=1"></button>' });
      const spy = interceptSnapshots(page, () => {
        throw new errors.TimeoutError('Injected snapshot timeout');
      });
      const first = await page.observe({});
      const ref = first.elements[0]?.ref;
      if (!ref) throw new Error('Missing button');
      await expect(page.act({ type: 'click', target: { ref } })).rejects.toMatchObject({
        code: 'STALE_TARGET',
        retryable: true,
      });
      expect(await backingPage(page).title()).toBe('');
      const second = await page.observe({});
      expect(second.revision).toBeGreaterThan(first.revision);
      spy.mockRestore();
      expect((await page.observe({})).revision).toBeGreaterThan(second.revision);
    } finally {
      await engine.close();
    }
  });

  it.each([40, 100])('shares the snapshot budget after the body spends %s ms', async (bodyWait) => {
    const engine = new PlaywrightChromiumEngine({ snapshotTimeoutMs: 100 });
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: `data:text/html,${'<button>Go</button>'.repeat(10)}` });
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const waits: number[] = [];
      interceptSnapshots(page, (kind, options) => {
        if (kind === 'body') {
          expect(options.timeout).toBe(100);
          now += bodyWait;
          return;
        }
        waits.push(options.timeout ?? 0);
        now += options.timeout ?? 0;
        throw new errors.TimeoutError('Injected budget exhaustion');
      });
      const observed = await page.observe({});
      expect(observed.elements.filter((element) => element.role === 'button')).toHaveLength(10);
      expect(waits).toEqual(bodyWait === 100 ? [] : [60]);
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
      for (const garbage of ['', 'abc', '-5', '0', '1000junk', '1.5', '1e3', 'Infinity', '30001']) {
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

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 30001, Number.MAX_SAFE_INTEGER])(
    'rejects invalid explicit timeout %s',
    (snapshotTimeoutMs) => {
      expect(() => new PlaywrightChromiumEngine({ snapshotTimeoutMs })).toThrow(RangeError);
    }
  );

  it('accepts bounded explicit values over the environment default', () => {
    vi.stubEnv('AGENTBROWSER_SNAPSHOT_TIMEOUT_MS', '2000');
    try {
      expect(new PlaywrightChromiumEngine({ snapshotTimeoutMs: 30000 }).snapshotTimeoutMs).toBe(
        30000
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe.each([false, true])('observed node identity (document fallback: %s)', (degraded) => {
  it('clicks the second identical button and includes checked controls', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<button onclick="document.title=1">Same</button><button onclick="document.title=2">Same</button><input type=checkbox aria-label=Choice checked>',
      });
      if (degraded) degradeElements(page);
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
        if (degraded) degradeElements(page);
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
