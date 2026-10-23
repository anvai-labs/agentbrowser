import type { EnginePage, EngineSession } from '@agentbrowser/engine';
import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { sharedEngine } from './test-support/shared-engine.js';

const engine = sharedEngine();

/**
 * Playwright exports Locator/ElementHandle shapes as types only, so spies
 * attach to the prototype of a live instance (same pattern as
 * target-identity.test.ts).
 */
function locatorPrototype(page: EnginePage): Locator {
  const backing = (page as unknown as { backingPage(): Page }).backingPage();
  return Object.getPrototypeOf(backing.locator('body')) as Locator;
}

/**
 * F5: overlay detection is opt-in diagnostics via include:["overlays"] —
 * visible occluders over examined elements, aggregated by identity, capped.
 * Never requested: no overlay probes run at all.
 */
describe('observe overlay detection', () => {
  const fixture =
    'data:text/html,<div style="position:fixed;inset:0;z-index:10"></div>' +
    '<button style="position:fixed;top:20px;left:20px">One</button>' +
    '<button style="position:fixed;top:80px;left:20px">Two</button>';

  it('is silent when not requested', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: fixture });
      const evaluate = vi.spyOn(locatorPrototype(page), 'evaluate');
      const state = await page.observe({});
      expect(state.overlays).toBeUndefined();
      expect(evaluate).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await session?.close();
    }
  });

  it('aggregates the occluding element over examined targets', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: fixture });
      const state = await page.observe({ include: ['overlays'] });
      expect(state.overlays).toEqual([{ tag: 'div', covers: 2 }]);
    } finally {
      await session?.close();
    }
  });

  it('caps examination at 30 visible elements', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      const buttons = Array.from(
        { length: 40 },
        (_, i) =>
          `<button style="position:fixed;top:${(i % 20) * 30 + 10}px;left:${Math.floor(i / 20) * 160 + 10}px">B${i}</button>`
      ).join('');
      await page.navigate({
        url: `data:text/html,<div style="position:fixed;inset:0;z-index:10"></div>${buttons}`,
      });
      const state = await page.observe({ include: ['overlays'] });
      expect(state.overlays).toEqual([{ tag: 'div', covers: 30 }]);
    } finally {
      await session?.close();
    }
  });

  it('skips elements whose probe throws', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: fixture });
      vi.spyOn(locatorPrototype(page), 'evaluate').mockRejectedValueOnce(new Error('probe failed'));
      const state = await page.observe({ include: ['overlays'] });
      expect(state.overlays).toEqual([{ tag: 'div', covers: 1 }]);
    } finally {
      vi.restoreAllMocks();
      await session?.close();
    }
  });

  it('reports no overlays when the page is clean', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: 'data:text/html,<button>Free</button>' });
      const state = await page.observe({ include: ['overlays'] });
      expect(state.overlays).toEqual([]);
    } finally {
      await session?.close();
    }
  });
});
