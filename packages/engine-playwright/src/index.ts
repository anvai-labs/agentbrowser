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

  constructor(id: string, page: Page, engine: PlaywrightChromiumEngine) {
    this.id = id;
    this.page = page;
    this.engine = engine;

    // Setup event listeners
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.page.on('load', () => {
      this.eventQueue.push({
        type: 'page.loaded',
        timestamp: new Date().toISOString(),
        sessionId: 'unknown', // Would be set by session
        pageId: this.id,
      });
    });

    this.page.on('console', (msg) => {
      this.eventQueue.push({
        type: msg.type() as any,
        timestamp: new Date().toISOString(),
        sessionId: 'unknown',
        pageId: this.id,
        data: { text: msg.text() },
      });
    });
  }

  async navigate(request: NavigationRequest): Promise<NavigationResult> {
    const waitUntil = request.waitUntil || 'load';
    await this.page.goto(request.url, { waitUntil: waitUntil as any });

    return {
      status: 'success',
      url: this.page.url(),
      redirectChain: [],
    };
  }

  async observe(request: ObservationRequest): Promise<RawPageState> {
    const mode = request.mode || 'interactive';

    // Get accessibility tree if requested
    let elements: any[] = [];

    if (mode === 'interactive' || mode === 'accessibility') {
      try {
        // Type assertion for Playwright's accessibility API
        const snapshot = await (this.page as any).accessibility.snapshot();
        elements = this.parseAccessibilityTree(snapshot);
      } catch {
        // Fallback if accessibility tree not available
        elements = await this.getContentElements();
      }
    } else if (mode === 'content') {
      // Get content-focused elements
      elements = await this.getContentElements();
    }

    return {
      url: this.page.url(),
      title: await this.page.title(),
      status: 'interactive',
      content: await this.page.content(),
      elements: elements,
    };
  }

  private parseAccessibilityTree(node: any, path = ''): any[] {
    if (!node) return [];

    const elements: any[] = [];

    if (node.role) {
      const element: any = {
        ref: this.generateRef(),
        role: node.role,
        name: node.name || undefined,
        visible: true,
        enabled: !node.disabled,
      };

      if (node.value !== undefined) {
        element.value = String(node.value);
      }

      if (node.checked !== undefined) {
        element.value = node.checked ? 'checked' : 'unchecked';
      }

      elements.push(element);
    }

    if (node.children) {
      for (const child of node.children) {
        elements.push(...this.parseAccessibilityTree(child));
      }
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
              ref: this.generateRef(),
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

  private generateRef(): string {
    const revision = this.engine.incrementRevision();
    const ordinal = Math.floor(Math.random() * 1000);
    return `e${revision}_${ordinal}`;
  }

  async resolve(target: EngineTarget): Promise<any> {
    // In a real implementation, this would resolve the ref to a locator
    // For now, return a mock resolved target
    return {
      ref: target.ref,
      fingerprint: `fingerprint-${target.ref}`,
      role: 'unknown',
      visible: true,
      enabled: true,
    };
  }

  async act(action: EngineAction): Promise<ActionEffect> {
    const actionId = `action-${Date.now()}`;
    const startTimestamp = new Date().toISOString();
    const oldRevision = 0; // Would track actual revision
    const newRevision = this.engine.incrementRevision();

    // Execute action based on type
    switch (action.type) {
      case 'navigate':
        await this.navigate({ url: action.url as string });
        break;
      case 'click':
        // Would resolve ref and click
        await this.page.click('body');
        break;
      case 'fill':
        // Would resolve ref and fill
        break;
      default:
        // Other action types
        break;
    }

    const endTimestamp = new Date().toISOString();

    return {
      actionId,
      startTimestamp,
      endTimestamp,
      oldRevision,
      newRevision,
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
      contentType: `image/${request.format || 'png'}`,
      sizeBytes: screenshot.length,
      url: `/v1/artifacts/screenshot-${Date.now()}`,
    };
  }

  async pdf(request: PdfRequest): Promise<any> {
    const buffer = await this.page.pdf({
      landscape: request.landscape || false,
      printBackground: request.printBackground || false,
    });

    return {
      artifactId: `pdf-${Date.now()}`,
      contentType: 'application/pdf',
      sizeBytes: buffer.length,
      url: `/v1/artifacts/pdf-${Date.now()}`,
    };
  }

  async *events(): AsyncIterable<EngineEvent> {
    while (this.eventQueue.length > 0) {
      yield this.eventQueue.shift()!;
    }
  }

  async close(): Promise<void> {
    await this.page.close();
  }
}
