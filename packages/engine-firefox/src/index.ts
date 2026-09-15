import { createHash, randomUUID } from 'node:crypto';
import {
  type BrowserEngine,
  type CapturedArtifact,
  type EngineAction,
  type EngineCapabilities,
  EngineError,
  type EngineEvent,
  type EnginePage,
  type EngineSession,
  type EngineSessionOptions,
  type EngineTarget,
  type ExtractionResult,
  type NavigationRequest,
  type NavigationResult,
  type NewPageOptions,
  type NormalizedCookie,
  type ObservationRequest,
  type RawElement,
  type RawPageState,
  type ResolvedTarget,
  type ScreenshotRequest,
} from '@agentbrowser/engine';
import {
  type Browser,
  type ElementHandle,
  type Page,
  launch as launchFirefox,
} from 'puppeteer-core';
import { describeElement, fingerprint } from './semantics.js';

const unsupported = (message: string) => new EngineError('ENGINE_UNSUPPORTED', message);
const stale = () =>
  new EngineError('STALE_TARGET', 'Observe again: target identity or semantics changed', true);
const ACTIONS = ['click', 'fill', 'press', 'select'] as const;

/** Independent driver/renderer qualification. No default-browser or CDP fallback. */
export class FirefoxBiDiEngine implements BrowserEngine {
  readonly name = 'firefox-bidi';
  readonly version = '1.8.13';
  private readonly sessions = new Set<FirefoxSession>();
  private readonly pending = new Set<Promise<EngineSession>>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    private readonly options: {
      executablePath: string;
      /** Test injection only; production always uses puppeteer-core. */
      launch?: typeof launchFirefox;
    }
  ) {}

  async capabilities(): Promise<EngineCapabilities> {
    return {
      supportsScreenshots: true,
      supportsPdf: false,
      supportsDownloads: false,
      supportsUploads: false,
      supportsJavascript: true,
      supportsWebgl: false,
      supportsVideo: false,
      supportsPersistentStorage: false,
      supportsAccessibilityTree: false,
      supportsCdp: false,
      supportedObservationModes: ['interactive', 'content'],
      supportedActionTypes: [...ACTIONS],
    };
  }

  async createSession(options: EngineSessionOptions): Promise<EngineSession> {
    const pending = this.start(options);
    this.pending.add(pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(pending);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new EngineError('ENGINE_CRASHED', 'Firefox engine is closed');
  }

  private async start(options: EngineSessionOptions): Promise<EngineSession> {
    this.assertOpen();
    if (options.requestPolicy !== undefined) {
      throw new EngineError(
        'ENGINE_UNSUPPORTED',
        'EGRESS_UNSUPPORTED: Firefox BiDi egress containment is not qualified; policy-bearing sessions are refused',
        false,
        { reason: 'EGRESS_UNSUPPORTED' }
      );
    }
    if (options.downloadPolicy !== undefined) throw unsupported('Download policy is not qualified');
    if (options.allowServiceWorkers !== undefined)
      throw unsupported('Service-worker policy is not qualified');
    if (options.timezoneId !== undefined) throw unsupported('Timezone emulation is not qualified');
    if (options.locale !== undefined) throw unsupported('Locale emulation is not qualified');
    if (options.snapshotTimeoutMs !== undefined)
      throw unsupported('Native accessibility snapshots are unavailable');
    if (!this.options.executablePath)
      throw unsupported('An explicit owned Firefox executable is required');
    const browser = await (this.options.launch ?? launchFirefox)({
      browser: 'firefox',
      protocol: 'webDriverBiDi',
      executablePath: this.options.executablePath,
      headless: options.headless ?? true,
      args: ['--no-remote'],
      defaultViewport: options.viewport ?? { width: 1280, height: 720 },
      // Omit userDataDir: Puppeteer creates and removes its own temporary profile.
    });
    if (this.closed) {
      await browser.close();
      this.assertOpen();
    }
    const session = new FirefoxSession(browser, () => this.sessions.delete(session));
    this.sessions.add(session);
    try {
      if (options.cookies?.length) await browser.setCookie(...options.cookies);
      this.assertOpen();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const results = await Promise.allSettled([
        ...[...this.sessions].map((session) => session.close()),
        ...[...this.pending].map((pending) =>
          pending.then(
            (session) => session.close(),
            () => {}
          )
        ),
      ]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    return this.closing;
  }
}

class FirefoxSession implements EngineSession {
  readonly id = `firefox-${randomUUID()}`;
  private readonly tracked = new Map<Page, FirefoxPage>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(
    private readonly browser: Browser,
    private readonly onClose: () => void
  ) {
    browser.on('disconnected', () => this.markClosed());
  }

  private wrap(page: Page): FirefoxPage {
    let wrapper = this.tracked.get(page);
    if (!wrapper) {
      wrapper = new FirefoxPage(page, this.id);
      this.tracked.set(page, wrapper);
    }
    return wrapper;
  }

  async newPage(options?: NewPageOptions): Promise<EnginePage> {
    if (this.closed) throw new EngineError('ENGINE_CRASHED', 'Firefox session closed');
    const page = await this.browser.newPage();
    try {
      if (this.closed) throw new EngineError('ENGINE_CRASHED', 'Firefox session closed');
      if (options?.viewport) await page.setViewport(options.viewport);
      if (this.closed) throw new EngineError('ENGINE_CRASHED', 'Firefox session closed');
      return this.wrap(page);
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  }

  async pages(): Promise<EnginePage[]> {
    if (this.closed) return [];
    const pages = await this.browser.pages();
    if (this.closed) return [];
    for (const [page, wrapper] of this.tracked) {
      if (!pages.includes(page)) {
        wrapper.markClosed();
        this.tracked.delete(page);
      }
    }
    return pages.filter((page) => !page.isClosed()).map((page) => this.wrap(page));
  }

  async cookies(): Promise<NormalizedCookie[]> {
    if (this.closed) throw new EngineError('ENGINE_CRASHED', 'Firefox session closed');
    return (await this.browser.cookies()).map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly ?? false,
      secure: cookie.secure,
      sameSite:
        cookie.sameSite === 'Strict' || cookie.sameSite === 'None' ? cookie.sameSite : 'Lax',
    }));
  }

  private markClosed(): void {
    this.closed = true;
    for (const page of this.tracked.values()) page.markClosed();
    this.tracked.clear();
    this.onClose();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.markClosed();
    this.closing = this.browser.close();
    return this.closing;
  }
}

type StoredElement = { handle: ElementHandle<Element>; description: RawElement; evidence: string };

class FirefoxPage implements EnginePage {
  readonly id = `page-${randomUUID()}`;
  private readonly refs = new Map<string, StoredElement>();
  private readonly evidenceSalt = randomUUID();
  private generation = 0;
  private closed = false;
  private busy = false;
  private readonly eventQueue: EngineEvent[] = [];
  private wake?: (() => void) | undefined;
  constructor(
    private readonly page: Page,
    private readonly sessionId: string
  ) {
    page.on('close', () => this.markClosed());
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        void this.clearRefs();
        this.emit('page.navigated', { url: page.url() });
      }
    });
    page.on('load', () => this.emit('page.loaded'));
  }

  // Direct-engine callers also get a single writer, without hidden queued retries.
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new EngineError('ENGINE_CRASHED', 'Firefox page closed');
    if (this.busy) throw new EngineError('SESSION_BUSY', 'Firefox page operation is in flight');
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }

  getCachedUrl(): string | undefined {
    return this.closed ? undefined : this.page.url();
  }
  async getUrl(): Promise<string> {
    return this.run(async () => this.page.url());
  }
  async waitForSelector(selector: string, options?: { timeoutMs?: number }): Promise<void> {
    return this.run(async () => {
      const handle = await this.page.waitForSelector(selector, {
        visible: true,
        timeout: options?.timeoutMs ?? 5000,
      });
      await handle?.dispose();
    });
  }

  navigate(request: NavigationRequest): Promise<NavigationResult> {
    return this.run(async () => {
      if (!['http:', 'https:', 'about:'].includes(new URL(request.url).protocol))
        throw unsupported('Only HTTP(S) and about: navigation is qualified');
      if (request.waitUntil === 'networkidle')
        throw unsupported('Network-idle navigation is not qualified');
      await this.clearRefs();
      const response = await this.page.goto(request.url, {
        waitUntil: request.waitUntil ?? 'load',
        timeout: 15_000,
      });
      return {
        status: 'success',
        url: this.page.url(),
        redirectChain:
          response
            ?.request()
            .redirectChain()
            .map((entry) => entry.url()) ?? [],
      };
    });
  }

  observe(request: ObservationRequest): Promise<RawPageState> {
    return this.run(async () => {
      if (request.mode && !['interactive', 'content'].includes(request.mode))
        throw unsupported(`Observation mode ${request.mode} is not qualified`);
      if ((request.scope && request.scope !== 'full') || request.include?.includes('overlays'))
        throw unsupported('Scoped and overlay observations are not qualified');
      await this.clearRefs();
      const generation = ++this.generation;
      const elements: RawElement[] = [];
      const handles = await this.page.$$(
        'a[href],button,input:not([type=hidden]),textarea,select,summary,[role]'
      );
      try {
        for (const handle of handles) {
          const inspection = await handle.evaluate(describeElement);
          const description = inspection?.description;
          if (!description?.visible || !inspection) {
            await handle.dispose();
            continue;
          }
          const ref = `e${generation}_${elements.length}`;
          const element = { ...description, ref };
          elements.push(element);
          this.refs.set(ref, {
            handle,
            description: element,
            evidence: this.evidenceDigest(inspection.evidence),
          });
        }
        return {
          revision: generation,
          url: this.page.url(),
          title: await this.page.title(),
          status: await this.page.evaluate(() => document.readyState),
          content: await this.page.content(),
          elements,
          degraded: true,
          degradedReason: 'dom-semantic-subset',
          metadata: {
            semantics: 'main-document-dom-subset',
            frames: 'not-observed',
            shadowDom: 'not-observed',
          },
        };
      } catch (error) {
        await Promise.allSettled(handles.map((handle) => handle.dispose()));
        await this.clearRefs();
        throw error;
      }
    });
  }

  private async checked(target: EngineTarget): Promise<StoredElement> {
    const stored = this.refs.get(target.ref);
    if (!stored) throw stale();
    let inspection: ReturnType<typeof describeElement>;
    try {
      inspection = await stored.handle.evaluate(describeElement);
    } catch {
      throw stale();
    }
    const live = inspection?.description;
    if (
      !inspection ||
      this.evidenceDigest(inspection.evidence) !== stored.evidence ||
      !live ||
      fingerprint(live) !== fingerprint(stored.description) ||
      live.checked !== stored.description.checked ||
      live.href !== stored.description.href
    )
      throw stale();
    return stored;
  }

  private evidenceDigest(evidence: string): string {
    return createHash('sha256').update(this.evidenceSalt).update(evidence).digest('hex');
  }

  resolve(target: EngineTarget): Promise<ResolvedTarget> {
    return this.run(async () => {
      const { description } = await this.checked(target);
      return {
        ref: target.ref,
        fingerprint: fingerprint(description),
        role: description.role,
        ...(description.name !== undefined ? { name: description.name } : {}),
        visible: description.visible,
        enabled: description.enabled,
      };
    });
  }

  act(action: EngineAction) {
    return this.run(async () => {
      if (!ACTIONS.some((type) => type === action.type))
        throw unsupported(`Action ${action.type} is not qualified`);
      if (action.expectValue !== undefined) throw unsupported('Fill verification is not qualified');
      if (action.remap) throw unsupported('Target remapping is not qualified');
      if (!action.target)
        throw new EngineError('INVALID_REQUEST', 'A fresh target ref is required');
      const { handle, description } = await this.checked(action.target);
      if (!description.enabled || !description.visible)
        throw new EngineError('INVALID_REQUEST', 'Target is not actionable');
      const startTimestamp = new Date().toISOString();
      const oldRevision = this.generation;
      switch (action.type) {
        case 'click':
          await handle.click();
          break;
        case 'fill': {
          if (
            typeof action.value !== 'string' ||
            !(await handle.evaluate(
              (element) =>
                element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ))
          )
            throw new EngineError(
              'INVALID_REQUEST',
              'Fill requires a native text input and string value'
            );
          await handle.focus();
          const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
          await this.page.keyboard.down(modifier);
          try {
            await this.page.keyboard.press('a');
          } finally {
            await this.page.keyboard.up(modifier);
          }
          await this.page.keyboard.press('Backspace');
          await handle.type(action.value);
          break;
        }
        case 'press': {
          if (typeof action.key !== 'string')
            throw new EngineError('INVALID_REQUEST', 'Press requires key');
          if (action.count !== undefined)
            throw unsupported('press count is not supported by this engine');
          await handle.press(action.key as Parameters<typeof handle.press>[0]);
          break;
        }
        case 'select': {
          if (
            !Array.isArray(action.values) ||
            !action.values.every((value) => typeof value === 'string')
          )
            throw new EngineError('INVALID_REQUEST', 'Select requires string values');
          await handle.select(...action.values);
          break;
        }
      }
      return {
        actionId: randomUUID(),
        startTimestamp,
        endTimestamp: new Date().toISOString(),
        oldRevision,
        newRevision: ++this.generation,
        result: { dispatched: true },
      };
    });
  }

  async extract(): Promise<ExtractionResult> {
    throw unsupported('Use service-level extraction');
  }
  screenshot(request: ScreenshotRequest): Promise<CapturedArtifact> {
    return this.run(async () => {
      if (request.maskSensitive !== false)
        throw unsupported(
          'Sensitive masking is not qualified; unmasked capture requires maskSensitive:false'
        );
      if (request.format && request.format !== 'png')
        throw unsupported('Only PNG capture is qualified');
      if (request.quality !== undefined) throw unsupported('PNG quality is not configurable');
      const bytes = await this.page.screenshot({
        type: 'png',
        fullPage: request.fullPage ?? false,
      });
      return {
        artifactId: randomUUID(),
        url: '',
        type: 'screenshot',
        contentType: 'image/png',
        sizeBytes: bytes.byteLength,
        bytesBase64: Buffer.from(bytes).toString('base64'),
      };
    });
  }

  private async clearRefs(): Promise<void> {
    const refs = [...this.refs.values()];
    this.refs.clear();
    await Promise.allSettled(refs.map(({ handle }) => handle.dispose()));
  }
  private emit(type: EngineEvent['type'], data?: Record<string, unknown>): void {
    if (this.closed) return;
    if (this.eventQueue.length === 100) this.eventQueue.shift();
    this.eventQueue.push({
      type,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      pageId: this.id,
      ...(data ? { data } : {}),
    });
    this.wake?.();
  }
  async *events(): AsyncIterable<EngineEvent> {
    while (!this.closed) {
      const event = this.eventQueue.shift();
      if (event) yield event;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
  markClosed(): void {
    this.closed = true;
    void this.clearRefs();
    this.eventQueue.length = 0;
    this.wake?.();
  }
  async close(): Promise<void> {
    this.markClosed();
    await this.page.close();
  }
}
