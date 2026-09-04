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
  EngineEventType,
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
import { DELIVERED_ACTION_TYPES, DELIVERED_OBSERVATION_MODES } from '@agentbrowser/protocol';

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
      supportedObservationModes: [...DELIVERED_OBSERVATION_MODES],
      supportedActionTypes: [...DELIVERED_ACTION_TYPES],
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
    page.registerRemoval(() => this._pages.delete(pageId));
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
  private removeSelf: () => void = () => {};
  private sessionOptions: EngineSessionOptions;
  private pageOptions: NewPageOptions | undefined;
  private currentUrl = 'about:blank';
  /** Browsing history for goBack/goForward (bounded). */
  /** Browsing history including the current entry (bounded). */
  private historyStack: string[] = ['about:blank'];
  private historyIndex = 0;
  private currentTitle = '';
  private pageStatus: 'loading' | 'interactive' | 'complete' = 'loading';
  private revision = 1;
  private elements: FakeElement[] = [];
  private elementByRef = new Map<string, FakeElement>();
  private closed = false;
  private crashed = false;
  private contentOverride: string | undefined;
  private eventQueue: EngineEvent[] = [];
  private eventWaiters: Array<() => void> = [];
  private eventsFinished = false;
  private pendingDialog:
    | { type: string; message: string; defaultPrompt: string; timer: NodeJS.Timeout }
    | undefined;
  private dialogHandledListener: ((record: Record<string, unknown>) => void) | undefined;
  /** Held-dialog auto-settle grace (short default suits tests). */
  private readonly dialogGraceMs = 60;

  /** Test hook: simulate a renderer crash. All subsequent ops throw. */
  crash(): void {
    this.crashed = true;
  }

  /** Test hook: pin the page's HTML content for extraction-style consumers. */
  setContent(html: string): void {
    this.contentOverride = html;
  }

  /** Test hook: open a dialog as a page would (held until acted on or grace). */
  emitDialog(dialog: { type: string; message: string; defaultPrompt?: string }): void {
    const timer = setTimeout(() => {
      this.settleDialog('auto', undefined);
    }, this.dialogGraceMs);
    this.pendingDialog = {
      type: dialog.type,
      message: dialog.message,
      defaultPrompt: dialog.defaultPrompt ?? '',
      timer,
    };
    this.emitEvent('dialog.opened', {
      dialogType: dialog.type,
      message: dialog.message,
      defaultPrompt: dialog.defaultPrompt ?? '',
    });
  }

  /** Test hook: observe how a held dialog was settled. */
  onDialogHandled(listener: (record: Record<string, unknown>) => void): void {
    this.dialogHandledListener = listener;
  }

  private settleDialog(reason: 'auto' | 'accepted' | 'dismissed', promptText?: string): void {
    const dialog = this.pendingDialog;
    if (!dialog) {
      return;
    }
    clearTimeout(dialog.timer);
    this.pendingDialog = undefined;
    const record: Record<string, unknown> = {
      dialog: reason,
      ...(promptText !== undefined ? { promptText } : {}),
      message: dialog.message,
    };
    this.dialogHandledListener?.(record);
    this.emitEvent('dialog.closed', { reason, ...record });
  }

  /** Test hook: emit an engine event to subscribers. */
  emitEvent(type: EngineEventType, data?: Record<string, unknown>): void {
    this.eventQueue.push({
      type,
      timestamp: new Date().toISOString(),
      sessionId: 'fake-engine',
      pageId: this.id,
      ...(data !== undefined ? { data } : {}),
    });
    const waiters = this.eventWaiters;
    this.eventWaiters = [];
    for (const wake of waiters) {
      wake();
    }
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

  /** Registered by the owning session so close() removes it from the map. */
  registerRemoval(remove: () => void): void {
    this.removeSelf = remove;
  }

  async navigate(request: NavigationRequest): Promise<NavigationResult> {
    this.assertNotDead();
    if (this.closed) {
      throw new Error('Page is closed');
    }

    // Classic history semantics: forward entries beyond the current
    // position are dropped, the new URL becomes the current entry.
    this.historyStack = [...this.historyStack.slice(0, this.historyIndex + 1), request.url];
    if (this.historyStack.length > 50) {
      this.historyStack = this.historyStack.slice(-50);
    }
    this.historyIndex = this.historyStack.length - 1;
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
      case 'acceptDialog':
      case 'dismissDialog': {
        // Dialog actions are non-mutating: no revision bump.
        if (!this.pendingDialog) {
          throw new Error('no dialog open');
        }
        if (action.type === 'acceptDialog') {
          this.settleDialog('accepted', action.promptText as string | undefined);
        } else {
          this.settleDialog('dismissed');
        }
        return {
          actionId,
          startTimestamp,
          endTimestamp: new Date().toISOString(),
          oldRevision,
          newRevision: this.revision,
          result:
            action.type === 'acceptDialog'
              ? { dialog: 'accepted', promptText: action.promptText }
              : { dialog: 'dismissed' },
        };
      }
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
      case 'dblclick':
        this.revision++;
        break;
      case 'hover':
      case 'wait':
        // Non-mutating: no state change, no revision bump.
        break;
      case 'clear': {
        const target = action.target as EngineTarget | undefined;
        if (target) {
          const element = this.elementByRef.get(target.ref);
          if (element) {
            element.value = '';
          }
        }
        this.revision++;
        break;
      }
      case 'check':
      case 'uncheck': {
        const target = action.target as EngineTarget | undefined;
        if (target) {
          const element = this.elementByRef.get(target.ref);
          if (element) {
            element.checked = action.type === 'check';
          }
        }
        this.revision++;
        break;
      }
      case 'goBack': {
        if (this.historyIndex > 0) {
          this.historyIndex--;
          this.currentUrl = this.historyStack[this.historyIndex] as string;
          this.revision++;
        }
        break;
      }
      case 'goForward': {
        if (this.historyIndex < this.historyStack.length - 1) {
          this.historyIndex++;
          this.currentUrl = this.historyStack[this.historyIndex] as string;
          this.revision++;
        }
        break;
      }
      case 'reload':
        this.revision++;
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

  async pdf(request: PdfRequest): Promise<any> {
    const content = `%PDF-1.4\nfake-page:${this.currentUrl}\nprinted:${request.printBackground === true}\n%%EOF`;
    return {
      artifactId: `pdf-${Date.now()}`,
      type: 'pdf',
      contentType: 'application/pdf',
      sizeBytes: content.length,
      url: '/v1/artifacts/pdf-1',
      bytesBase64: Buffer.from(content, 'utf8').toString('base64'),
    };
  }

  async screenshot(request: ScreenshotRequest): Promise<any> {
    const format = request.format || 'png';
    const content = `fake-screenshot:${this.currentUrl}:${format}:full=${request.fullPage === true}`;
    const bytes = Buffer.from(content, 'utf8');
    return {
      artifactId: `screenshot-${Date.now()}`,
      type: 'screenshot',
      contentType: `image/${format}`,
      sizeBytes: bytes.length,
      url: '/v1/artifacts/screenshot-1',
      bytesBase64: bytes.toString('base64'),
    };
  }

  async *events(): AsyncIterable<EngineEvent> {
    for (;;) {
      while (this.eventQueue.length > 0) {
        yield this.eventQueue.shift() as EngineEvent;
      }
      if (this.eventsFinished || this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.eventWaiters.push(resolve);
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.eventsFinished = true;
    if (this.pendingDialog) {
      clearTimeout(this.pendingDialog.timer);
      this.pendingDialog = undefined;
    }
    this.removeSelf();
    const waiters = this.eventWaiters;
    this.eventWaiters = [];
    for (const wake of waiters) {
      wake();
    }
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
  /** Toggled state for check/uncheck semantics. */
  checked?: boolean;
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
