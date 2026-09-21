import type {
  EnginePage,
  EngineSession,
  EngineSessionOptions,
  RawElement,
} from '@agentbrowser/engine';
import type { Browser, Cookie } from 'puppeteer-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirefoxBiDiEngine } from './index.js';
import { describeElement } from './semantics.js';

/** What describeElement would return for one element, as the engine consumes it in-process. */
type ElementInspection = { description: Omit<RawElement, 'ref'>; evidence: string };

const inspection = (overrides: Partial<Omit<RawElement, 'ref'>> = {}): ElementInspection => {
  const description: Omit<RawElement, 'ref'> = {
    role: 'button',
    name: 'Save',
    visible: true,
    enabled: true,
    ...overrides,
  };
  return { description, evidence: JSON.stringify(description) };
};

/**
 * Records the engine's effects in call order across pages, keyboards and
 * handles so tests can assert whole sequences (e.g. the select-all typing dance).
 */
class FakeElementHandle {
  disposed = false;
  inspection: ElementInspection | null;
  private readonly trace: string[];

  constructor(inspection: ElementInspection | null, trace: string[] = []) {
    this.inspection = inspection;
    this.trace = trace;
  }

  async evaluate(fn: (element: Element) => unknown): Promise<unknown> {
    if (this.disposed) throw new Error('Protocol error: ElementHandle disposed');
    if (fn === describeElement) return this.inspection;
    // The fill path asks whether the node is a native text field.
    return this.inspection?.description.role === 'textbox';
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.trace.push('dispose');
  }
  async click(): Promise<void> {
    this.trace.push('click');
  }
  async focus(): Promise<void> {
    this.trace.push('focus');
  }
  async type(text: string): Promise<void> {
    this.trace.push(`type:${text}`);
  }
  async press(key: string): Promise<void> {
    this.trace.push(`press:${key}`);
  }
  async select(...values: string[]): Promise<void> {
    this.trace.push(`select:${values.join(',')}`);
  }
}

class FakePage {
  private readonly listeners = new Map<string, Array<(payload: unknown) => void>>();
  private readonly mainFrameToken = { isMain: true };
  readonly trace: string[] = [];
  urlValue = 'about:blank';
  titleValue = 'Fixture page';
  contentValue = '<html><body>fixture</body></html>';
  readyState = 'complete';
  elements: FakeElementHandle[] = [];
  viewport?: unknown;
  closed = false;
  closeCalls = 0;
  viewportError?: Error;
  readonly gotoCalls: Array<{ url: string; options: unknown }> = [];
  gotoResponse: { request: () => { redirectChain: () => Array<{ url: () => string }> } } | null =
    null;
  gotoImpl?: (url: string, options: unknown) => Promise<unknown>;
  readonly waitForSelectorCalls: Array<{ selector: string; options: unknown }> = [];
  waitForSelectorResult: FakeElementHandle | null = null;
  readonly screenshotCalls: unknown[] = [];
  screenshotBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  on(event: string, listener: (payload: unknown) => void): this {
    const registered = this.listeners.get(event) ?? [];
    registered.push(listener);
    this.listeners.set(event, registered);
    return this;
  }
  emit(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
  mainFrame(): unknown {
    return this.mainFrameToken;
  }
  url(): string {
    return this.urlValue;
  }
  isClosed(): boolean {
    return this.closed;
  }
  async setViewport(viewport: unknown): Promise<void> {
    if (this.viewportError) throw this.viewportError;
    this.viewport = viewport;
  }
  async goto(url: string, options: unknown): Promise<unknown> {
    this.gotoCalls.push({ url, options });
    if (this.gotoImpl) return this.gotoImpl(url, options);
    this.urlValue = url;
    return this.gotoResponse;
  }
  async $$(): Promise<FakeElementHandle[]> {
    return this.elements;
  }
  async title(): Promise<string> {
    return this.titleValue;
  }
  async content(): Promise<string> {
    return this.contentValue;
  }
  async evaluate(): Promise<string> {
    return this.readyState;
  }
  async waitForSelector(selector: string, options: unknown): Promise<FakeElementHandle | null> {
    this.waitForSelectorCalls.push({ selector, options });
    return this.waitForSelectorResult;
  }
  readonly keyboard = {
    calls: this.trace,
    async down(key: string): Promise<void> {
      this.calls.push(`key:down:${key}`);
    },
    async up(key: string): Promise<void> {
      this.calls.push(`key:up:${key}`);
    },
    async press(key: string): Promise<void> {
      this.calls.push(`key:press:${key}`);
    },
  };
  async screenshot(options: unknown): Promise<Buffer> {
    this.screenshotCalls.push(options);
    return this.screenshotBytes;
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.closed = true;
  }
}

class FakeBrowser {
  private readonly listeners = new Map<string, Array<() => void>>();
  readonly pagesPool: FakePage[] = [];
  newPageCalls = 0;
  closeCalls = 0;
  nextPage?: FakePage;
  closeError?: Error;
  setCookieError?: Error;
  cookiesValue: Cookie[] = [];
  readonly seededCookies: Cookie[] = [];

  on(event: string, listener: () => void): this {
    const registered = this.listeners.get(event) ?? [];
    registered.push(listener);
    this.listeners.set(event, registered);
    return this;
  }
  disconnect(): void {
    for (const listener of this.listeners.get('disconnected') ?? []) listener();
  }
  async newPage(): Promise<FakePage> {
    this.newPageCalls += 1;
    const page = this.nextPage ?? new FakePage();
    this.nextPage = undefined;
    this.pagesPool.push(page);
    return page;
  }
  async pages(): Promise<FakePage[]> {
    return [...this.pagesPool];
  }
  async cookies(): Promise<Cookie[]> {
    return this.cookiesValue;
  }
  async setCookie(...cookies: Cookie[]): Promise<void> {
    if (this.setCookieError) throw this.setCookieError;
    this.seededCookies.push(...cookies);
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
  }
}

interface Harness {
  engine: FirefoxBiDiEngine;
  launch: ReturnType<typeof vi.fn>;
  browser: FakeBrowser;
  session: EngineSession;
}

const openEngines: FirefoxBiDiEngine[] = [];

afterEach(async () => {
  await Promise.all(openEngines.splice(0).map((engine) => engine.close().catch(() => {})));
});

const startSession = async (
  options: EngineSessionOptions = {},
  browser = new FakeBrowser()
): Promise<Harness> => {
  const launch = vi.fn(async () => browser as unknown as Browser);
  const engine = new FirefoxBiDiEngine({
    executablePath: '/owned/firefox',
    launch: launch as never,
  });
  openEngines.push(engine);
  const session = await engine.createSession(options);
  return { engine, launch, browser, session };
};

const newFakeBackedPage = async (
  browser: FakeBrowser,
  session: EngineSession
): Promise<{ page: EnginePage; fakePage: FakePage }> => {
  const page = await session.newPage();
  return { page, fakePage: browser.pagesPool[browser.pagesPool.length - 1]! };
};

const observeTarget = async (
  fakePage: FakePage,
  page: EnginePage,
  overrides: Partial<Omit<RawElement, 'ref'>> = {}
): Promise<{ handle: FakeElementHandle; target: { ref: string } }> => {
  const handle = new FakeElementHandle(inspection(overrides), fakePage.trace);
  fakePage.elements = [handle];
  const state = await page.observe({});
  return { handle, target: { ref: state.elements[0]?.ref ?? '' } };
};

describe('FirefoxBiDiEngine against fake puppeteer surfaces', () => {
  describe('session lifecycle', () => {
    it('refuses every unqualified session option before launching Firefox', async () => {
      const launch = vi.fn();
      const engine = new FirefoxBiDiEngine({
        executablePath: '/owned/firefox',
        launch: launch as never,
      });
      openEngines.push(engine);
      const refused: EngineSessionOptions[] = [
        { downloadPolicy: { allow: false, maxBytes: 1024 } },
        { allowServiceWorkers: true },
        { timezoneId: 'UTC' },
        { locale: 'en-US' },
        { snapshotTimeoutMs: 5000 },
      ];
      for (const options of refused) {
        await expect(engine.createSession(options)).rejects.toMatchObject({
          code: 'ENGINE_UNSUPPORTED',
        });
      }
      expect(launch).not.toHaveBeenCalled();
    });

    it('requires an explicitly owned Firefox executable', async () => {
      const launch = vi.fn();
      const engine = new FirefoxBiDiEngine({ executablePath: '', launch: launch as never });
      openEngines.push(engine);
      await expect(engine.createSession({})).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' });
      expect(launch).not.toHaveBeenCalled();
    });

    it('seeds cookies onto the browser before handing over the session', async () => {
      const cookies: EngineSessionOptions['cookies'] = [
        {
          name: 'sid',
          value: 'owned',
          domain: 'fixture.test',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ];
      const { browser, launch } = await startSession({ cookies });
      expect(browser.seededCookies).toEqual(cookies);
      expect(launch).toHaveBeenCalledOnce();
    });

    it('closes the launched browser when cookie seeding fails', async () => {
      const browser = new FakeBrowser();
      browser.setCookieError = new Error('seed rejected');
      const launch = vi.fn(async () => browser as unknown as Browser);
      const engine = new FirefoxBiDiEngine({
        executablePath: '/owned/firefox',
        launch: launch as never,
      });
      openEngines.push(engine);
      await expect(
        engine.createSession({
          cookies: [
            {
              name: 'sid',
              value: 'owned',
              domain: 'fixture.test',
              path: '/',
              secure: true,
              httpOnly: false,
              sameSite: 'Lax',
            },
          ],
        })
      ).rejects.toMatchObject({ message: 'seed rejected' });
      expect(browser.closeCalls).toBe(1);
    });

    it('propagates the first session-close failure during engine shutdown', async () => {
      const browser = new FakeBrowser();
      browser.closeError = new Error('close failed');
      const { engine } = await startSession({}, browser);
      await expect(engine.close()).rejects.toMatchObject({ message: 'close failed' });
    });

    it('shares one closing promise so repeated session closes shut the browser once', async () => {
      const { browser, session } = await startSession();
      await Promise.all([session.close(), session.close()]);
      await expect(session.close()).resolves.toBeUndefined();
      expect(browser.closeCalls).toBe(1);
    });

    it('marks the session and its live pages closed when the browser disconnects', async () => {
      const { browser, session } = await startSession();
      const { page } = await newFakeBackedPage(browser, session);
      browser.disconnect();
      await expect(session.newPage()).rejects.toMatchObject({ code: 'ENGINE_CRASHED' });
      await expect(session.cookies()).rejects.toMatchObject({ code: 'ENGINE_CRASHED' });
      expect(page.getCachedUrl()).toBeUndefined();
      expect(await session.pages()).toEqual([]);
      expect(browser.newPageCalls).toBe(1);
      await expect(session.close()).resolves.toBeUndefined();
    });

    it('refuses page creation on a closed session without touching the browser', async () => {
      const { browser, session } = await startSession();
      await session.close();
      await expect(session.newPage()).rejects.toMatchObject({ code: 'ENGINE_CRASHED' });
      expect(browser.newPageCalls).toBe(0);
    });

    it('applies the requested viewport to the underlying page', async () => {
      const { browser, session } = await startSession();
      const page = await session.newPage({ viewport: { width: 800, height: 600 } });
      const fakePage = browser.pagesPool[browser.pagesPool.length - 1]!;
      expect(fakePage.viewport).toEqual({ width: 800, height: 600 });
      await page.close();
    });

    it('closes the underlying page when configuring it fails', async () => {
      const browser = new FakeBrowser();
      const failing = new FakePage();
      failing.viewportError = new Error('viewport refused');
      browser.nextPage = failing;
      const { session } = await startSession({}, browser);
      await expect(session.newPage({ viewport: { width: 10, height: 10 } })).rejects.toMatchObject({
        message: 'viewport refused',
      });
      expect(failing.closeCalls).toBe(1);
    });

    it('returns one wrapper per live page and prunes wrappers for pages closed elsewhere', async () => {
      const { browser, session } = await startSession();
      const first = await session.newPage();
      const second = await session.newPage();
      const listed = await session.pages();
      expect(listed).toEqual([first, second]);

      // The first tab is closed outside the engine's knowledge.
      const secondFake = browser.pagesPool[1]!;
      browser.pagesPool.length = 0;
      browser.pagesPool.push(secondFake);
      const remaining = await session.pages();
      expect(remaining).toEqual([second]);
      expect(first.getCachedUrl()).toBeUndefined();
      expect(second.getCachedUrl()).toBe('about:blank');
    });

    it('filters closed tabs out of the page listing', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      fakePage.closed = true;
      expect(await session.pages()).toEqual([]);
      expect(page.getCachedUrl()).toBe('about:blank');
    });

    it('normalizes cookie sameSite values into the protocol enum', async () => {
      const browser = new FakeBrowser();
      browser.cookiesValue = [
        {
          name: 'strict',
          value: '1',
          domain: 'fixture.test',
          path: '/',
          secure: true,
          sameSite: 'Strict',
        },
        {
          name: 'none',
          value: '2',
          domain: 'fixture.test',
          path: '/',
          secure: true,
          sameSite: 'None',
        },
        {
          name: 'lax',
          value: '3',
          domain: 'fixture.test',
          path: '/',
          secure: false,
          httpOnly: true,
          expires: 12345,
          sameSite: 'Lax',
        },
        // Firefox reports values outside the enum; they must not leak through.
        {
          name: 'unspecified',
          value: '4',
          domain: 'fixture.test',
          path: '/',
          secure: false,
          sameSite: 'unspecified',
        },
        { name: 'absent', value: '5', domain: 'fixture.test', path: '/', secure: false },
      ] as unknown as Cookie[];
      const { session } = await startSession({}, browser);
      expect(await session.cookies()).toEqual([
        {
          name: 'strict',
          value: '1',
          domain: 'fixture.test',
          path: '/',
          expires: undefined,
          httpOnly: false,
          secure: true,
          sameSite: 'Strict',
        },
        {
          name: 'none',
          value: '2',
          domain: 'fixture.test',
          path: '/',
          expires: undefined,
          httpOnly: false,
          secure: true,
          sameSite: 'None',
        },
        {
          name: 'lax',
          value: '3',
          domain: 'fixture.test',
          path: '/',
          expires: 12345,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
        {
          name: 'unspecified',
          value: '4',
          domain: 'fixture.test',
          path: '/',
          expires: undefined,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        },
        {
          name: 'absent',
          value: '5',
          domain: 'fixture.test',
          path: '/',
          expires: undefined,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        },
      ]);
    });
  });

  describe('page primitives', () => {
    it('reports cached and live URLs and refuses operations after close', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      fakePage.urlValue = 'https://fixture.test/list';
      expect(page.getCachedUrl()).toBe('https://fixture.test/list');
      await expect(page.getUrl()).resolves.toBe('https://fixture.test/list');
      await page.close();
      expect(page.getCachedUrl()).toBeUndefined();
      await expect(page.getUrl()).rejects.toMatchObject({ code: 'ENGINE_CRASHED' });
    });

    it('refuses an overlapping operation while one is in flight', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      let release!: () => void;
      const gated = new Promise<void>((resolve) => {
        release = resolve;
      });
      fakePage.gotoImpl = () => gated;
      const navigation = page.navigate({ url: 'https://fixture.test/gated' });
      await expect(page.getUrl()).rejects.toMatchObject({ code: 'SESSION_BUSY' });
      release();
      await expect(navigation).resolves.toMatchObject({ status: 'success' });
    });

    it('waits for a selector with a visible timeout and releases the handle', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const handle = new FakeElementHandle(inspection(), fakePage.trace);
      fakePage.waitForSelectorResult = handle;
      await page.waitForSelector!('form button', { timeoutMs: 2500 });
      expect(handle.disposed).toBe(true);
      expect(fakePage.waitForSelectorCalls).toEqual([
        { selector: 'form button', options: { visible: true, timeout: 2500 } },
      ]);
      fakePage.waitForSelectorResult = null;
      await page.waitForSelector!('nothing');
      expect(fakePage.waitForSelectorCalls[1]).toEqual({
        selector: 'nothing',
        options: { visible: true, timeout: 5000 },
      });
    });

    it('rejects navigation outside the qualified URL schemes before any goto', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      await expect(page.navigate({ url: 'ftp://fixture.test/file' })).rejects.toMatchObject({
        code: 'ENGINE_UNSUPPORTED',
      });
      expect(fakePage.gotoCalls).toEqual([]);
    });

    it('rejects network-idle navigation', async () => {
      const { browser, session } = await startSession();
      const { page } = await newFakeBackedPage(browser, session);
      await expect(
        page.navigate({ url: 'https://fixture.test/', waitUntil: 'networkidle' })
      ).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' });
    });

    it('navigates with load semantics and maps the redirect chain', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      fakePage.gotoResponse = {
        request: () => ({
          redirectChain: () => [
            { url: () => 'https://fixture.test/one' },
            { url: () => 'https://fixture.test/two' },
          ],
        }),
      };
      await expect(page.navigate({ url: 'https://fixture.test/final' })).resolves.toEqual({
        status: 'success',
        url: 'https://fixture.test/final',
        redirectChain: ['https://fixture.test/one', 'https://fixture.test/two'],
      });
      expect(fakePage.gotoCalls).toEqual([
        { url: 'https://fixture.test/final', options: { waitUntil: 'load', timeout: 15_000 } },
      ]);
    });

    it('reports an empty redirect chain without a response and clears stored refs', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { handle, target } = await observeTarget(fakePage, page);
      await expect(page.navigate({ url: 'about:blank' })).resolves.toMatchObject({
        status: 'success',
        redirectChain: [],
      });
      expect(handle.disposed).toBe(true);
      await expect(page.act({ type: 'click', target })).rejects.toMatchObject({
        code: 'STALE_TARGET',
      });
    });

    it('refuses extraction at the engine layer', async () => {
      const { browser, session } = await startSession();
      const { page } = await newFakeBackedPage(browser, session);
      await expect(page.extract({})).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' });
    });
  });

  describe('observation', () => {
    it('refuses unqualified modes, scopes and overlay includes', async () => {
      const { browser, session } = await startSession();
      const { page } = await newFakeBackedPage(browser, session);
      await expect(page.observe({ mode: 'accessibility' })).rejects.toMatchObject({
        code: 'ENGINE_UNSUPPORTED',
      });
      await expect(page.observe({ scope: 'viewport' })).rejects.toMatchObject({
        code: 'ENGINE_UNSUPPORTED',
      });
      await expect(page.observe({ include: ['overlays'] })).rejects.toMatchObject({
        code: 'ENGINE_UNSUPPORTED',
      });
    });

    it('stamps refs on visible elements, disposes the rest and reports degraded metadata', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      fakePage.elements = [
        new FakeElementHandle(inspection({ role: 'button', name: 'Save' }), fakePage.trace),
        new FakeElementHandle(
          inspection({ role: 'generic', name: 'hidden', visible: false }),
          fakePage.trace
        ),
        new FakeElementHandle(null, fakePage.trace),
      ];
      const state = await page.observe({ mode: 'content' });
      expect(state).toMatchObject({
        revision: 1,
        url: 'about:blank',
        title: 'Fixture page',
        status: 'complete',
        content: '<html><body>fixture</body></html>',
        degraded: true,
        degradedReason: 'dom-semantic-subset',
        metadata: {
          semantics: 'main-document-dom-subset',
          frames: 'not-observed',
          shadowDom: 'not-observed',
        },
      });
      expect(state.elements).toEqual([
        { ref: 'e1_0', role: 'button', name: 'Save', visible: true, enabled: true },
      ]);
      expect(fakePage.elements[0]?.disposed).toBe(false);
      expect(fakePage.elements[1]?.disposed).toBe(true);
      expect(fakePage.elements[2]?.disposed).toBe(true);
    });

    it('allocates a fresh generation per observation and releases the previous handles', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const firstHandle = new FakeElementHandle(inspection({ name: 'First' }), fakePage.trace);
      fakePage.elements = [firstHandle];
      const first = await page.observe({});
      const secondHandle = new FakeElementHandle(inspection({ name: 'Second' }), fakePage.trace);
      fakePage.elements = [secondHandle];
      const second = await page.observe({});
      expect(first.elements[0]?.ref).toBe('e1_0');
      expect(second.elements[0]?.ref).toBe('e2_0');
      expect(second.revision).toBe(2);
      expect(firstHandle.disposed).toBe(true);
      expect(secondHandle.disposed).toBe(false);
    });

    it('disposes every handle and rethrows when an inspection fails mid-observation', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const good = new FakeElementHandle(inspection({ name: 'Good' }), fakePage.trace);
      const bad = new FakeElementHandle(inspection({ name: 'Bad' }), fakePage.trace);
      vi.spyOn(bad, 'evaluate').mockRejectedValue(new Error('execution context destroyed'));
      fakePage.elements = [good, bad];
      await expect(page.observe({})).rejects.toMatchObject({
        message: 'execution context destroyed',
      });
      expect(good.disposed).toBe(true);
      expect(bad.disposed).toBe(true);
    });
  });

  describe('target freshness', () => {
    it('rejects refs that were never observed on this page', async () => {
      const { browser, session } = await startSession();
      const { page } = await newFakeBackedPage(browser, session);
      await expect(page.resolve({ ref: 'e1_0' })).rejects.toMatchObject({ code: 'STALE_TARGET' });
      await expect(page.act({ type: 'click', target: { ref: 'e9_9' } })).rejects.toMatchObject({
        code: 'STALE_TARGET',
      });
    });

    it('rejects targets whose handle is gone', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { handle, target } = await observeTarget(fakePage, page);
      await handle.dispose();
      await expect(page.resolve(target)).rejects.toMatchObject({ code: 'STALE_TARGET' });
    });

    it('rejects targets whose inspection evidence changed', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { handle, target } = await observeTarget(fakePage, page);
      const stored = handle.inspection!;
      handle.inspection = { description: stored.description, evidence: 'tampered' };
      await expect(page.act({ type: 'click', target })).rejects.toMatchObject({
        code: 'STALE_TARGET',
      });
    });

    it('rejects targets whose semantics changed without tripping the evidence digest', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { handle, target } = await observeTarget(fakePage, page);
      const stored = handle.inspection!;
      handle.inspection = {
        description: { ...stored.description, name: 'Renamed' },
        evidence: stored.evidence,
      };
      await expect(page.resolve(target)).rejects.toMatchObject({ code: 'STALE_TARGET' });
    });

    it('rejects a checkbox whose checked state flipped', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { handle, target } = await observeTarget(fakePage, page, {
        role: 'checkbox',
        name: 'Agree',
        checked: true,
      });
      const stored = handle.inspection!;
      handle.inspection = {
        description: { ...stored.description, checked: false },
        evidence: stored.evidence,
      };
      await expect(page.act({ type: 'click', target })).rejects.toMatchObject({
        code: 'STALE_TARGET',
      });
    });

    it('rejects a link whose href changed', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { handle, target } = await observeTarget(fakePage, page, {
        role: 'link',
        name: 'Docs',
        href: 'https://fixture.test/a',
      });
      const stored = handle.inspection!;
      handle.inspection = {
        description: { ...stored.description, href: 'https://fixture.test/b' },
        evidence: stored.evidence,
      };
      await expect(page.act({ type: 'click', target })).rejects.toMatchObject({
        code: 'STALE_TARGET',
      });
    });
  });

  describe('resolve', () => {
    it('returns the fingerprint and semantics of a stable target', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { target } = await observeTarget(fakePage, page, {
        role: 'textbox',
        name: 'Note',
        value: 'draft',
      });
      await expect(page.resolve(target)).resolves.toEqual({
        ref: target.ref,
        fingerprint: 'textbox_Note_visible_true_enabled_true_value_draft',
        role: 'textbox',
        name: 'Note',
        visible: true,
        enabled: true,
      });
    });

    it('omits the name field entirely when the element has none', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { target } = await observeTarget(fakePage, page, {
        role: 'generic',
        name: undefined,
      });
      await expect(page.resolve(target)).resolves.toStrictEqual({
        ref: target.ref,
        fingerprint: 'generic_visible_true_enabled_true',
        role: 'generic',
        visible: true,
        enabled: true,
      });
    });
  });

  describe('act', () => {
    it('refuses unqualified actions and malformed requests before touching the target', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { target } = await observeTarget(fakePage, page);
      await expect(page.act({ type: 'evaluate', expression: '1' })).rejects.toMatchObject({
        code: 'ENGINE_UNSUPPORTED',
      });
      await expect(page.act({ type: 'typeText', target, value: 'x' })).rejects.toMatchObject({
        code: 'ENGINE_UNSUPPORTED',
      });
      await expect(page.act({ type: 'click', expectValue: 'x' })).rejects.toMatchObject({
        code: 'ENGINE_UNSUPPORTED',
      });
      await expect(page.act({ type: 'click', target, remap: true })).rejects.toMatchObject({
        code: 'ENGINE_UNSUPPORTED',
      });
      await expect(page.act({ type: 'click' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(page.act({ type: 'press', target })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
      await expect(
        page.act({ type: 'press', target, key: 'Enter', count: 2 })
      ).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' });
      await expect(page.act({ type: 'select', target, values: [42] })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
      expect(fakePage.trace).toEqual([]);
    });

    it('refuses to act on a disabled target', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { target } = await observeTarget(fakePage, page, { enabled: false });
      await expect(page.act({ type: 'click', target })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
      expect(fakePage.trace).toEqual([]);
    });

    it('clicks a stable target and bumps the revision', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { target } = await observeTarget(fakePage, page);
      const result = await page.act({ type: 'click', target });
      expect(fakePage.trace).toEqual(['click']);
      expect(result).toMatchObject({
        oldRevision: 1,
        newRevision: 2,
        result: { dispatched: true },
      });
      expect(result.actionId).toEqual(expect.any(String));
      expect(new Date(result.endTimestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(result.startTimestamp).getTime()
      );
    });

    it('fills a native text field with select-all, delete and typing', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { target } = await observeTarget(fakePage, page, { role: 'textbox', name: 'Note' });
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.act({ type: 'fill', target, value: 'hello' });
      expect(fakePage.trace).toEqual([
        'focus',
        `key:down:${modifier}`,
        'key:press:a',
        `key:up:${modifier}`,
        'key:press:Backspace',
        'type:hello',
      ]);
    });

    it('refuses fill with a non-string value and on non-text targets', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { target } = await observeTarget(fakePage, page, { role: 'textbox', name: 'Note' });
      await expect(page.act({ type: 'fill', target, value: 42 })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
      const { target: buttonTarget } = await observeTarget(fakePage, page, {
        role: 'button',
        name: 'Save',
      });
      await expect(
        page.act({ type: 'fill', target: buttonTarget, value: 'nope' })
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        message: 'Fill requires a native text input and string value',
      });
      // Re-observing pruned the first ref; no dispatch effect ever ran.
      expect(fakePage.trace.filter((entry) => entry !== 'dispose')).toEqual([]);
    });

    it('presses a key on a stable target and bumps the revision', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { target } = await observeTarget(fakePage, page);
      const result = await page.act({ type: 'press', target, key: 'Enter' });
      expect(fakePage.trace).toEqual(['press:Enter']);
      expect(result).toMatchObject({ oldRevision: 1, newRevision: 2 });
    });

    it('selects string options on a stable target', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { target } = await observeTarget(fakePage, page, { role: 'combobox', name: 'Color' });
      await page.act({ type: 'select', target, values: ['blue', 'green'] });
      expect(fakePage.trace).toEqual(['select:blue,green']);
    });
  });

  describe('screenshot', () => {
    it('refuses capture unless it is explicitly unmasked PNG without quality', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      await expect(page.screenshot({})).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' });
      await expect(page.screenshot({ maskSensitive: true })).rejects.toMatchObject({
        code: 'ENGINE_UNSUPPORTED',
      });
      await expect(page.screenshot({ maskSensitive: false, format: 'jpeg' })).rejects.toMatchObject(
        { code: 'ENGINE_UNSUPPORTED' }
      );
      await expect(page.screenshot({ maskSensitive: false, quality: 80 })).rejects.toMatchObject({
        code: 'ENGINE_UNSUPPORTED',
      });
      expect(fakePage.screenshotCalls).toEqual([]);
    });

    it('captures PNG bytes as a base64 artifact', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      fakePage.screenshotBytes = Buffer.from([1, 2, 3, 4]);
      const artifact = await page.screenshot({ maskSensitive: false, fullPage: true });
      expect(artifact).toMatchObject({
        type: 'screenshot',
        contentType: 'image/png',
        sizeBytes: 4,
        bytesBase64: Buffer.from([1, 2, 3, 4]).toString('base64'),
      });
      expect(artifact.artifactId).toEqual(expect.any(String));
      expect(fakePage.screenshotCalls).toEqual([{ type: 'png', fullPage: true }]);
    });
  });

  describe('events and close', () => {
    it('emits page.loaded and main-frame page.navigated, clearing refs on navigation', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { handle, target } = await observeTarget(fakePage, page);
      const iterator = page.events()[Symbol.asyncIterator]();
      fakePage.emit('framenavigated', { isMain: false });
      fakePage.emit('load');
      fakePage.urlValue = 'https://fixture.test/next';
      fakePage.emit('framenavigated', fakePage.mainFrame());
      const loaded = await iterator.next();
      const navigated = await iterator.next();
      expect(loaded.value).toMatchObject({
        type: 'page.loaded',
        sessionId: session.id,
        pageId: page.id,
      });
      expect(navigated.value).toMatchObject({
        type: 'page.navigated',
        data: { url: 'https://fixture.test/next' },
      });
      await expect(page.act({ type: 'click', target })).rejects.toMatchObject({
        code: 'STALE_TARGET',
      });
      expect(handle.disposed).toBe(true);
    });

    it('caps the event queue at 100, dropping the oldest', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const iterator = page.events()[Symbol.asyncIterator]();
      for (let i = 0; i < 105; i += 1) {
        fakePage.urlValue = `https://fixture.test/${i}`;
        fakePage.emit('framenavigated', fakePage.mainFrame());
      }
      const drained: Array<{ data?: { url?: string } }> = [];
      let next = await iterator.next();
      while (!next.done) {
        drained.push(next.value as { data?: { url?: string } });
        if (drained.length === 100) break;
        next = await iterator.next();
      }
      expect(drained).toHaveLength(100);
      expect(drained[0]?.data?.url).toBe('https://fixture.test/5');
      expect(drained[99]?.data?.url).toBe('https://fixture.test/104');
    });

    it('holds readers asleep until an event arrives and ends the stream once closed', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const iterator = page.events()[Symbol.asyncIterator]();
      const pending = iterator.next();
      fakePage.emit('load');
      expect((await pending).value).toMatchObject({ type: 'page.loaded' });
      const hanging = iterator.next();
      await page.close();
      expect((await hanging).done).toBe(true);
    });

    it('drops events emitted after close and ends the stream immediately', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      await page.close();
      fakePage.emit('load');
      const iterator = page.events()[Symbol.asyncIterator]();
      expect((await iterator.next()).done).toBe(true);
    });

    it('releases refs and forgets the URL when the underlying tab closes', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      const { handle, target } = await observeTarget(fakePage, page);
      fakePage.closed = true;
      fakePage.emit('close');
      expect(page.getCachedUrl()).toBeUndefined();
      expect(handle.disposed).toBe(true);
      expect(await session.pages()).toEqual([]);
      await expect(page.act({ type: 'click', target })).rejects.toMatchObject({
        code: 'ENGINE_CRASHED',
      });
    });

    it('tolerates repeated page closes', async () => {
      const { browser, session } = await startSession();
      const { page, fakePage } = await newFakeBackedPage(browser, session);
      await page.close();
      await page.close();
      expect(fakePage.closeCalls).toBe(2);
    });
  });
});
