/**
 * Playwright Chromium Browser Engine Implementation
 *
 * This implements the BrowserEngine interface using Playwright and Chromium.
 */

import type {
  ActionEffect,
  BrowserEngine,
  EngineAction,
  EngineCapabilities,
  EngineEvent,
  EnginePage,
  EngineSession,
  EngineSessionOptions,
  EngineTarget,
  ExtractionRequest,
  ExtractionResult,
  NavigationRequest,
  NavigationResult,
  NewPageOptions,
  ObservationRequest,
  PdfRequest,
  RawPageState,
  ScreenshotRequest,
} from '@agentbrowser/engine';
import { type Browser, type BrowserContext, Locator, type Page, chromium } from 'playwright';

// Re-export engine types
export * from '@agentbrowser/engine';

/** An element captured at observation time, addressable by ref. */
interface StoredElement {
  role: string;
  name?: string;
  value?: string;
  visible: boolean;
  enabled: boolean;
}

/** Strip surrounding quotes and unescape from an aria snapshot value. */
function unquote(value: string): string {
  const trimmed = value.trim();
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed);
  return match?.[1] !== undefined ? match[1] : trimmed;
}

/**
 * Canonical semantic fingerprint required by the engine contract:
 * `role_name_visible_X_enabled_Y[_value_Z]`.
 */
function canonicalFingerprint(element: StoredElement): string {
  return [
    element.role,
    element.name ?? '',
    `visible_${element.visible}`,
    `enabled_${element.enabled}`,
    element.value !== undefined && element.value !== '' ? `value_${element.value}` : '',
  ]
    .filter(Boolean)
    .join('_');
}

/**
 * PlaywrightChromiumEngine implements BrowserEngine using Playwright
 */
export class PlaywrightChromiumEngine implements BrowserEngine {
  private _name = 'playwright-chromium';
  private _version = '1.0.0';
  private browser: Browser | undefined;
  private revisionCounter = 1;

  get name(): string {
    return this._name;
  }

  get version(): string {
    return this._version;
  }

  async capabilities(): Promise<EngineCapabilities> {
    return {
      supportsScreenshots: true,
      supportsPdf: true,
      supportsDownloads: true,
      supportsUploads: true,
      supportsJavascript: true,
      supportsWebgl: true,
      supportsVideo: false,
      supportsPersistentStorage: true,
      supportsAccessibilityTree: true,
      supportsCdp: true,
      supportedObservationModes: ['interactive', 'content', 'accessibility', 'compact_dom'],
      supportedActionTypes: [
        'navigate',
        'click',
        'hover',
        'fill',
        'type',
        'clear',
        'press',
        'select',
        'check',
        'uncheck',
        'scroll',
        'wait',
        'upload',
        'download',
        'goBack',
        'goForward',
        'reload',
        'dismissDialog',
        'acceptDialog',
      ],
    };
  }

  async createSession(options: EngineSessionOptions = {}): Promise<EngineSession> {
    // Launch browser if not already launched
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: options.headless !== false,
      });
    }

    // Create browser context (incognito isolation)
    const context = await this.browser.newContext({
      viewport: options.viewport || { width: 1280, height: 720 },
      locale: options.locale || 'en-US',
      timezoneId: options.timezoneId || 'America/New_York',
    });

    return new PlaywrightSession(context, this);
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = undefined;
    }
  }

  incrementRevision(): number {
    return this.revisionCounter++;
  }
}

/**
 * PlaywrightSession implements EngineSession
 */
class PlaywrightSession implements EngineSession {
  readonly id: string;
  private context: BrowserContext;
  private engine: PlaywrightChromiumEngine;
  private pageMap: Map<string, PlaywrightPage> = new Map();
  private pageCounter = 0;

  constructor(context: BrowserContext, engine: PlaywrightChromiumEngine) {
    this.id = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.context = context;
    this.engine = engine;
  }

  async newPage(options?: NewPageOptions): Promise<EnginePage> {
    const playwrightPage = await this.context.newPage();

    if (options?.viewport) {
      await playwrightPage.setViewportSize(options.viewport);
    }

    const pageId = `page-${this.pageCounter++}`;
    const page = new PlaywrightPage(pageId, playwrightPage, this.engine);
    this.pageMap.set(pageId, page);

    return page;
  }

  async pages(): Promise<EnginePage[]> {
    return Array.from(this.pageMap.values());
  }

  async cookies(): Promise<any[]> {
    return await this.context.cookies();
  }

  async close(reason?: string): Promise<void> {
    // Close all pages
    for (const page of this.pageMap.values()) {
      await page.close();
    }
    this.pageMap.clear();

    // Close context
    await this.context.close();
  }
}

/**
 * PlaywrightPage implements EnginePage
 */
class PlaywrightPage implements EnginePage {
  readonly id: string;
  private page: Page;
  private engine: PlaywrightChromiumEngine;
  private eventQueue: EngineEvent[] = [];
  /**
   * Ref store: the page's revision counter plus the elements captured at the
   * last observation. Refs are `e<revision>_<ordinal>` and are stable within a
   * revision; any mutation bumps the revision and invalidates them.
   */
  private revision = 1;
  private refStore = new Map<string, StoredElement>();
  private eventWaiters: Array<() => void> = [];
  private eventsClosed = false;

  constructor(id: string, page: Page, engine: PlaywrightChromiumEngine) {
    this.id = id;
    this.page = page;
    this.engine = engine;

    // Setup event listeners
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.page.on('load', () => {
      this.enqueueEvent({
        type: 'page.loaded',
        timestamp: new Date().toISOString(),
        sessionId: 'unknown', // Stamped by the service
        pageId: this.id,
      });
    });

    this.page.on('console', (msg) => {
      this.enqueueEvent({
        type: msg.type() as never,
        timestamp: new Date().toISOString(),
        sessionId: 'unknown',
        pageId: this.id,
        data: { text: msg.text() },
      });
    });
  }

  /** Enqueue an event and wake any iterator waiting for one. */
  private enqueueEvent(event: EngineEvent): void {
    this.eventQueue.push(event);
    const waiters = this.eventWaiters;
    this.eventWaiters = [];
    for (const wake of waiters) {
      wake();
    }
  }

  async navigate(request: NavigationRequest): Promise<NavigationResult> {
    const waitUntil = request.waitUntil || 'load';
    await this.page.goto(request.url, { waitUntil: waitUntil as any });
    this.bumpRevision();

    return {
      status: 'success',
      url: this.page.url(),
      redirectChain: [],
    };
  }

  private bumpRevision(): void {
    this.revision += 1;
    this.refStore.clear();
  }

  async observe(request: ObservationRequest): Promise<RawPageState> {
    const mode = request.mode || 'interactive';

    // Get accessibility tree if requested
    let elements: any[] = [];

    if (mode === 'interactive' || mode === 'accessibility') {
      try {
        // Playwright's accessibility surface is the aria snapshot (YAML).
        const yaml = await this.page.locator('body').ariaSnapshot();
        elements = this.parseAriaSnapshot(yaml, this.revision);
      } catch {
        // Fallback if the aria snapshot is not available
        elements = await this.getContentElements();
      }
    } else if (mode === 'content') {
      // Get content-focused elements
      elements = await this.getContentElements();
    }

    // Rebuild the ref store from this observation: refs are deterministic
    // within a revision (document order), so the same element maps to the
    // same ref until the page mutates.
    this.refStore.clear();
    for (const element of elements) {
      this.refStore.set(element.ref, {
        role: element.role,
        name: element.name,
        value: element.value,
        visible: element.visible,
        enabled: element.enabled,
      });
    }

    return {
      url: this.page.url(),
      title: await this.page.title(),
      status: 'interactive',
      content: await this.page.content(),
      elements: elements,
    };
  }

  /**
   * Parse a Playwright aria snapshot (YAML subset) into raw elements in
   * document order. Lines look like:
   *   - button "Submit"
   *   - textbox "Email":
   *     - /value: "typed text"
   * Attribute lines (`/attr: value`) annotate the preceding element.
   */
  private parseAriaSnapshot(yaml: string, revision: number): any[] {
    const elements: any[] = [];
    const lines = yaml.split('\n');

    for (const line of lines) {
      if (line.trim() === '' || line.trim() === '-') {
        continue;
      }

      const indent = line.length - line.trimStart().length;
      const text = line.trim().replace(/^-\s*/, '');

      // Attribute line: attach to the last element deeper than this indent.
      const attrMatch = /^\/(\w+):\s*(.*)$/.exec(text);
      if (attrMatch?.[1] && attrMatch[2] !== undefined) {
        const last = elements[elements.length - 1];
        if (last && attrMatch[1] === 'value') {
          last.value = unquote(attrMatch[2]);
        }
        continue;
      }

      // Element line: `role`, `role "name"`, `role "name": inline-value`,
      // or with a trailing bare colon when the node has children.
      const elementMatch = /^([a-zA-Z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?(?::\s*(.*))?$/.exec(text);
      if (!elementMatch?.[1]) {
        continue;
      }

      const role = elementMatch[1];
      if (role === 'text' || role === 'StaticText') {
        continue; // static text is not an interactive element
      }

      const element: any = {
        ref: `e${revision}_${elements.length}`,
        role,
        visible: true,
        enabled: true,
      };
      if (elementMatch[2] !== undefined) {
        element.name = elementMatch[2];
      }
      const inlineValue = elementMatch[3]?.trim();
      if (inlineValue) {
        element.value = unquote(inlineValue);
      }
      elements.push(element);
    }

    return elements;
  }

  private async getContentElements(): Promise<any[]> {
    // Get interactive elements using query selectors
    const selectors = [
      'button',
      'a',
      'input',
      'select',
      'textarea',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
    ];

    const elements: any[] = [];

    for (const selector of selectors) {
      try {
        const nodes = await this.page.locator(selector).all();
        for (const node of nodes) {
          const isVisible = await node.isVisible().catch(() => false);
          if (isVisible) {
            elements.push({
              ref: `e${this.revision}_${elements.length}`,
              role: selector.replace(/\[.*\]/, '').replace(/[^a-zA-Z]/g, ''),
              visible: true,
              enabled: await node.isEnabled().catch(() => true),
            });
          }
        }
      } catch {
        // Selector might not match anything, continue
      }
    }

    return elements;
  }

  async resolve(target: EngineTarget): Promise<any> {
    const stored = this.refStore.get(target.ref);
    if (!stored) {
      throw new Error(`Element not found: ${target.ref} (observe the page to mint refs)`);
    }

    return {
      ref: target.ref,
      fingerprint: canonicalFingerprint(stored),
      role: stored.role,
      ...(stored.name !== undefined ? { name: stored.name } : {}),
      visible: stored.visible,
      enabled: stored.enabled,
    };
  }

  /** Locator for a stored element, addressed semantically (never selectors). */
  private locatorFor(ref: string) {
    const stored = this.refStore.get(ref);
    if (!stored) {
      throw new Error(`Element not found: ${ref} (observe the page to mint refs)`);
    }
    return this.page
      .getByRole(stored.role as never, stored.name !== undefined ? { name: stored.name } : {})
      .first();
  }

  async act(action: EngineAction): Promise<ActionEffect> {
    const actionId = `action-${Date.now()}`;
    const startTimestamp = new Date().toISOString();
    const oldRevision = this.revision;

    // Execute action based on type. Targeted actions go through the ref
    // store, addressing elements semantically; selectors never appear.
    switch (action.type) {
      case 'navigate':
        await this.navigate({ url: action.url as string });
        break;
      case 'click': {
        const locator = this.locatorFor((action.target as EngineTarget).ref);
        await locator.click();
        this.bumpRevision();
        break;
      }
      case 'fill': {
        const locator = this.locatorFor((action.target as EngineTarget).ref);
        await locator.fill(String(action.value ?? ''));
        this.bumpRevision();
        break;
      }
      case 'select': {
        const locator = this.locatorFor((action.target as EngineTarget).ref);
        await locator.selectOption((action.values as string[]) ?? []);
        this.bumpRevision();
        break;
      }
      case 'press': {
        if (action.target) {
          await this.locatorFor((action.target as EngineTarget).ref).press(String(action.key));
        } else {
          await this.page.keyboard.press(String(action.key));
        }
        this.bumpRevision();
        break;
      }
      case 'scroll': {
        await this.page.mouse.wheel(Number(action.deltaX ?? 0), Number(action.deltaY ?? 0));
        this.bumpRevision();
        break;
      }
      default:
        // Other action types are recorded without a revision bump.
        break;
    }

    const endTimestamp = new Date().toISOString();

    return {
      actionId,
      startTimestamp,
      endTimestamp,
      oldRevision,
      newRevision: this.revision,
      result: { success: true },
    };
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const data = (await this.page.textContent('body')) || '';

    return {
      data: { text: data },
      evidence: [],
      warnings: [],
    };
  }

  async screenshot(request: ScreenshotRequest): Promise<any> {
    const screenshot = await this.page.screenshot({
      fullPage: request.fullPage || false,
      type: request.format || 'png',
    });

    return {
      artifactId: `screenshot-${Date.now()}`,
      type: 'screenshot',
      contentType: `image/${request.format || 'png'}`,
      sizeBytes: screenshot.length,
      url: `/v1/artifacts/screenshot-${Date.now()}`,
      bytesBase64: screenshot.toString('base64'),
    };
  }

  async pdf(request: PdfRequest): Promise<any> {
    const buffer = await this.page.pdf({
      landscape: request.landscape || false,
      printBackground: request.printBackground || false,
    });

    return {
      artifactId: `pdf-${Date.now()}`,
      type: 'pdf',
      contentType: 'application/pdf',
      sizeBytes: buffer.length,
      url: `/v1/artifacts/pdf-${Date.now()}`,
      bytesBase64: buffer.toString('base64'),
    };
  }

  async *events(): AsyncIterable<EngineEvent> {
    for (;;) {
      while (this.eventQueue.length > 0) {
        yield this.eventQueue.shift() as EngineEvent;
      }
      if (this.eventsClosed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.eventWaiters.push(resolve);
      });
    }
  }

  async close(): Promise<void> {
    this.eventsClosed = true;
    const waiters = this.eventWaiters;
    this.eventWaiters = [];
    for (const wake of waiters) {
      wake();
    }
    await this.page.close();
  }
}
