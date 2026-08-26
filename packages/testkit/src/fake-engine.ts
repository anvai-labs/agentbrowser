/**
 * FakeEngine - In-memory implementation for contract testing
 *
 * This is a TDD implementation of the BrowserEngine interface that doesn't
 * require a real browser. It's used for contract testing and development.
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
  RawPageState,
  ScreenshotRequest,
} from '@agentbrowser/engine';

/**
 * Fake engine for testing
 */
export class FakeEngine implements BrowserEngine {
  private _name = 'fake-engine';
  private _version = '1.0.0';

  private sessions: Map<string, FakeSession> = new Map();
  private sessionCounter = 0;

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
      supportsWebgl: false,
      supportsVideo: false,
      supportsPersistentStorage: true,
      supportsAccessibilityTree: true,
      supportsCdp: false,
      supportedObservationModes: ['interactive', 'content', 'accessibility'],
      supportedActionTypes: ['navigate', 'click', 'fill', 'select', 'scroll', 'press'],
    };
  }

  async createSession(options: EngineSessionOptions): Promise<EngineSession> {
    const sessionId = `fake-session-${this.sessionCounter++}`;
    const session = new FakeSession(sessionId, options);
    this.sessions.set(sessionId, session);
    return session;
  }

  async close(): Promise<void> {
    // Close all sessions
    for (const session of this.sessions.values()) {
      await session.close();
    }
    this.sessions.clear();
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getSession(sessionId: string): FakeSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get a page's test handle for injecting state. Test-only surface: real
   * engines never expose their pages this way. Accepts either the engine's own
   * page id or a composite id that embeds it (e.g. `pg_1_fake-page-0`).
   */
  getFakePage(sessionId: string, pageId: string): FakePage | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    const direct = session.getFakePage(pageId);
    if (direct) {
      return direct;
    }
    for (const page of session.getPageHandles()) {
      if (pageId.endsWith(`_${page.id}`)) {
        return page;
      }
    }
    return undefined;
  }

  /** Engine-internal session ids, for tests that need to reach into a page. */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }
}

/**
 * Fake session for testing
 */
class FakeSession implements EngineSession {
  readonly id: string;
  private _pages: Map<string, FakePage> = new Map();
  private pageCounter = 0;
  private closed = false;
  private options: EngineSessionOptions;

  constructor(id: string, options: EngineSessionOptions) {
    this.id = id;
    this.options = options;
  }

  async newPage(options?: NewPageOptions): Promise<EnginePage> {
    if (this.closed) {
      throw new Error('Session is closed');
    }

    const pageId = `fake-page-${this.pageCounter++}`;
    const pageOptions = options ? { ...options } : undefined;
    const page = new FakePage(pageId, this.options, pageOptions);
    this._pages.set(pageId, page);
    return page;
  }

  async pages(): Promise<EnginePage[]> {
    return Array.from(this._pages.values());
  }

  async cookies(): Promise<any[]> {
    return [];
  }

  async close(reason?: string): Promise<void> {
    this.closed = true;
    // Close all pages
    for (const page of this._pages.values()) {
      await page.close();
    }
    this._pages.clear();
  }

  isClosed(): boolean {
    return this.closed;
  }

  getFakePage(pageId: string): FakePage | undefined {
    return this._pages.get(pageId);
  }

  getPageHandles(): FakePage[] {
    return Array.from(this._pages.values());
  }
}

/**
 * Fake page for testing
 */
class FakePage implements EnginePage {
  readonly id: string;
  private sessionOptions: EngineSessionOptions;
  private pageOptions: NewPageOptions | undefined;
  private currentUrl = 'about:blank';
  private currentTitle = '';
  private pageStatus: 'loading' | 'interactive' | 'complete' = 'loading';
  private revision = 1;
  private elements: FakeElement[] = [];
  private elementByRef = new Map<string, FakeElement>();
  private closed = false;
  private crashed = false;
  private contentOverride: string | undefined;

  /** Test hook: simulate a renderer crash. All subsequent ops throw. */
  crash(): void {
    this.crashed = true;
  }

  /** Test hook: pin the page's HTML content for extraction-style consumers. */
  setContent(html: string): void {
    this.contentOverride = html;
  }

  /** Throws when the page has crashed or been closed by the engine. */
  private assertNotDead(): void {
    if (this.crashed) {
      throw new Error('Page crashed');
    }
  }

  constructor(id: string, sessionOptions: EngineSessionOptions, pageOptions?: NewPageOptions) {
    this.id = id;
    this.sessionOptions = sessionOptions;
    this.pageOptions = pageOptions ? { ...pageOptions } : undefined;
  }

  async navigate(request: NavigationRequest): Promise<NavigationResult> {
    this.assertNotDead();
    if (this.closed) {
      throw new Error('Page is closed');
    }

    this.currentUrl = request.url;
    this.pageStatus = 'loading';
    this.revision++;

    // Simulate page load
    this.pageStatus = 'interactive';
    this.currentTitle = `Page: ${request.url}`;

    // Generate fake elements
    this.elements = this.generateFakeElements();

    return {
      status: 'success',
      url: request.url,
      redirectChain: [],
    };
  }

  async observe(request: ObservationRequest): Promise<RawPageState> {
    this.assertNotDead();
    if (this.closed) {
      throw new Error('Page is closed');
    }

    // Generate observation
    const observation: RawPageState = {
      url: this.currentUrl,
      title: this.currentTitle,
      status: this.pageStatus,
      content:
        this.contentOverride ??
        `<html><head><title>${this.currentTitle}</title></head><body></body></html>`,
      elements: this.elements.map((el) => {
        const element: any = {
          ref: el.ref,
          role: el.role,
          visible: el.visible,
          enabled: el.enabled,
        };

        if (el.name !== undefined) {
          element.name = el.name;
        }

        if (el.value !== undefined) {
          element.value = el.value;
        }

        if (el.required !== undefined) {
          element.required = el.required;
        }

        if (el.focused !== undefined) {
          element.focused = el.focused;
        }

        if (el.attributes !== undefined) {
          element.attributes = el.attributes;
        }

        if (el.risk !== undefined) {
          element.risk = el.risk;
        }

        return element;
      }),
    };

    return observation;
  }

  async resolve(target: EngineTarget): Promise<any> {
    this.assertNotDead();
    if (this.closed) {
      throw new Error('Page is closed');
    }

    // Find element by ref using Map for O(1) lookup
    const element = this.elementByRef.get(target.ref);
    if (!element) {
      throw new Error('Element not found');
    }

    const result: any = {
      ref: element.ref,
      fingerprint: this.generateFingerprint(element),
      role: element.role,
      visible: element.visible,
      enabled: element.enabled,
    };

    if (element.name !== undefined) {
      result.name = element.name;
    }

    if (element.value !== undefined && element.value !== '') {
      result.value = element.value;
    }

    if (element.required !== undefined && element.required !== false) {
      result.required = element.required;
    }

    if (element.focused !== undefined && element.focused !== false) {
      result.focused = element.focused;
    }

    return result;
  }

  async act(action: EngineAction): Promise<ActionEffect> {
    this.assertNotDead();
    if (this.closed) {
      throw new Error('Page is closed');
    }

    const actionId = `action-${Date.now()}`;
    const startTimestamp = new Date().toISOString();
    const oldRevision = this.revision;

    // Process action
    switch (action.type) {
      case 'click':
        this.revision++;
        break;
      case 'fill': {
        // A real page keeps the typed value; so does the fake.
        const target = action.target as EngineTarget | undefined;
        if (target) {
          const element = this.elementByRef.get(target.ref);
          if (element && typeof action.value === 'string') {
            element.value = action.value;
          }
        }
        this.revision++;
        break;
      }
      case 'select': {
        const target = action.target as EngineTarget | undefined;
        if (target) {
          const element = this.elementByRef.get(target.ref);
          const values = action.values as string[] | undefined;
          if (element && values && values[0] !== undefined) {
            element.value = values[0];
          }
        }
        this.revision++;
        break;
      }
      case 'navigate':
        await this.navigate({ url: action.url as string });
        break;
      default:
        this.revision++;
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
    return {
      data: { extracted: true },
      evidence: [],
    };
  }

  async screenshot(request: ScreenshotRequest): Promise<any> {
    const format = request.format || 'png';
    return {
      artifactId: `screenshot-${Date.now()}`,
      type: 'screenshot',
      contentType: `image/${format}`,
      sizeBytes: 1024,
      url: '/v1/artifacts/screenshot-1',
    };
  }

  async *events(): AsyncIterable<EngineEvent> {
    // No events by default
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private generateFakeElements(): FakeElement[] {
    const elements: FakeElement[] = [];

    // Generate some fake interactive elements
    const roleTypes = ['button', 'textbox', 'link', 'heading'] as const;

    for (let i = 0; i < 5; i++) {
      const roleIndex = i % roleTypes.length;
      const role = roleTypes[roleIndex];

      if (!role) {
        continue; // Skip if role is somehow undefined (shouldn't happen)
      }

      const element: FakeElement = {
        ref: `e${this.revision}_${i + 1}`,
        role: role,
        name: `Element ${i + 1}`,
        value: '',
        required: false,
        visible: true,
        enabled: true,
        focused: i === 0,
        attributes: { 'data-testid': `element-${i + 1}` },
      };

      elements.push(element);
    }

    // Update the ref->element Map index
    this.elementByRef.clear();
    for (const element of elements) {
      this.elementByRef.set(element.ref, element);
    }

    return elements;
  }

  /**
   * Canonical semantic fingerprint required by the engine contract:
   * `role_name_visible_X_enabled_Y[_value_Z]`. Core compares resolved
   * fingerprints against this derivation, so engines must match it exactly.
   */
  private generateFingerprint(element: FakeElement): string {
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
   * Replace the page's elements (test hook for injecting specific state,
   * including risk classification).
   */
  setElements(elements: Array<Partial<FakeElement>>): void {
    this.elements = elements.map((el, index) => ({
      ref: el.ref ?? `e${this.revision}_${index + 1}`,
      role: el.role ?? 'unknown',
      name: el.name ?? '',
      value: el.value ?? '',
      required: el.required ?? false,
      visible: el.visible ?? true,
      enabled: el.enabled ?? true,
      focused: el.focused ?? false,
      ...(el.risk !== undefined ? { risk: el.risk } : {}),
      attributes: el.attributes ?? {},
    }));
    // Keep the ref index in sync: resolve() and act() read the Map.
    this.syncElementIndex();
  }

  /** Rebuild the ref->element index after this.elements is replaced. */
  private syncElementIndex(): void {
    this.elementByRef.clear();
    for (const element of this.elements) {
      this.elementByRef.set(element.ref, element);
    }
  }
}

/**
 * Fake element
 */
interface FakeElement {
  ref: string;
  role: string;
  name: string;
  value: string;
  required: boolean;
  visible: boolean;
  enabled: boolean;
  focused: boolean;
  risk?:
    | 'read'
    | 'write-local'
    | 'external-message'
    | 'transaction'
    | 'account-security'
    | 'destructive';
  attributes: Record<string, string>;
}
