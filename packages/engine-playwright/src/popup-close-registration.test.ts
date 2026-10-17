import { setImmediate as settleEvents } from 'node:timers/promises';
import type { EngineEvent, EnginePage, EngineSession } from '@agentbrowser/engine';
import type { BrowserContext, Page } from 'playwright';
import { expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

type InternalPage = EnginePage & {
  backingPage(): Page;
  emitExternalEvent(event: EngineEvent): void;
};
type InternalSession = EngineSession & {
  context: BrowserContext;
  downloads: Map<string, unknown>;
  registerPlaywrightPage(
    page: Page,
    viewport?: { width: number; height: number }
  ): Promise<InternalPage>;
};
const listenerNames = [
  'download',
  'close',
  'dialog',
  'load',
  'console',
  'pageerror',
  'crash',
  'framenavigated',
];
const handlers = (page: Page) => new Map(listenerNames.map((name) => [name, page.listeners(name)]));
function expectOwnedHandlersRemoved(page: Page, baseline: ReturnType<typeof handlers>) {
  for (const name of listenerNames) {
    // Playwright's own once-close listener can disappear naturally; its other
    // listeners must survive, while no newly attached engine handler may remain.
    expect(
      page.listeners(name).every((handler) => baseline.get(name)?.includes(handler)),
      name
    ).toBe(true);
  }
}

it.each(['before registration', 'during viewport setup'])(
  'refuses a page closed %s without registering handlers or a phantom page',
  async (timing) => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = (await engine.createSession({ headless: true })) as InternalSession;
      const opener = (await session.newPage()) as InternalPage;
      const raw = await opener.backingPage().context().newPage();
      await settleEvents();
      const baseline = handlers(raw);
      if (timing === 'before registration') await raw.close();
      else vi.spyOn(raw, 'setViewportSize').mockImplementationOnce(async () => raw.close());
      await expect(
        session.registerPlaywrightPage(
          raw,
          timing === 'during viewport setup' ? { width: 800, height: 600 } : undefined
        )
      ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });
      expectOwnedHandlersRemoved(raw, baseline);
      expect((await session.pages()).map((page) => page.id)).toEqual([opener.id]);
      expect([...session.downloads.keys()]).toEqual([opener.id]);
    } finally {
      await engine.close();
    }
  }
);

it.each(['before registration', 'before announcement'])(
  'omits a popup creation announcement when it closes %s',
  async (timing) => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const session = (await engine.createSession({ headless: true })) as InternalSession;
      const opener = (await session.newPage()) as InternalPage;
      const announced = vi.spyOn(opener, 'emitExternalEvent');
      const registered = Promise.withResolvers<void>();
      let baseline: ReturnType<typeof handlers> | undefined;
      const register = session.registerPlaywrightPage.bind(session);
      vi.spyOn(session, 'registerPlaywrightPage').mockImplementationOnce(async (raw) => {
        baseline = handlers(raw);
        try {
          if (timing === 'before registration') await raw.close();
          const page = await register(raw);
          if (timing === 'before announcement') await raw.close();
          return page;
        } finally {
          registered.resolve();
        }
      });
      const [popup] = await Promise.all([
        opener.backingPage().waitForEvent('popup'),
        opener.backingPage().evaluate("window.open('about:blank')"),
      ]);
      await registered.promise;
      await settleEvents();
      expect(popup.isClosed()).toBe(true);
      expect(announced.mock.calls.filter(([event]) => event.type === 'page.created')).toEqual([]);
      expect((await session.pages()).map((page) => page.id)).toEqual([opener.id]);
      expect([...session.downloads.keys()]).toEqual([opener.id]);
      expect(baseline).toBeDefined();
      expectOwnedHandlersRemoved(popup, baseline!);
    } finally {
      await engine.close();
    }
  }
);

it('a browser-closed adopted page removes owned handlers and ends its stream without removing caller handlers', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const session = (await engine.createSession({ headless: true })) as InternalSession;
    let baseline: ReturnType<typeof handlers> = new Map();
    session.context.once('page', (raw) => {
      baseline = handlers(raw);
    });
    const page = (await session.newPage()) as InternalPage;
    const raw = page.backingPage();
    const callerClose = vi.fn();
    raw.on('close', callerClose);
    baseline.get('close')!.push(callerClose);
    const pump = (async () => {
      for await (const _event of page.events()) {
        // Drain until the browser-owned close ends the iterator.
      }
    })();
    await raw.close();
    await pump;
    expect(callerClose).toHaveBeenCalledOnce();
    expectOwnedHandlersRemoved(raw, baseline);
    expect(raw.listeners('close')).toContain(callerClose);
    expect(await session.pages()).toEqual([]);
    expect(session.downloads.size).toBe(0);
    await page.close();
    expect(callerClose).toHaveBeenCalledOnce();
  } finally {
    await engine.close();
  }
});
