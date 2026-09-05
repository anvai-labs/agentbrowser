/**
 * Real Safari engine via macOS `safaridriver` (W3C WebDriver).
 *
 * TD-BROWSER-7 Phase 2. Why this exists: Playwright's `webkit` build is
 * Safari's engine, not Safari — iCloud Keychain, device-trust SSO, and
 * corporate SSO reject it. safaridriver automates the user's actual Safari.
 *
 * Contract notes (all deliberate, none accidental):
 * - Always headed. Safari has no headless mode; `capabilities.alwaysHeaded`
   declares it and the contract suite requests accordingly. The SERVICE
   rejects explicit `headless: true` loudly (SAFARI_HEADLESS_UNSUPPORTED).
 * - No egress choke point: WebDriver cannot intercept network traffic.
   Sessions carrying a request policy are refused (EGRESS_UNSUPPORTED)
   instead of running silently unguarded (ADR-006 honesty).
 * - Cookie seeding is deferred to the first navigation: WebDriver can only
   set cookies for the active document's origin, which does not exist before
   navigation. Seeded cookies flush after the first successful navigate.
 * - Cookie export via GET /session/:id/cookie includes httpOnly values —
   the strongest credential handoff in the fleet (ADR-005).
 * - No PDF, no console/network event stream: loud unsupported / documented
   gap respectively.
 */

import type {
  ActionEffect,
  BrowserEngine,
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
  NormalizedCookie,
  ObservationRequest,
  RawPageState,
  ResolvedTarget,
  ScreenshotRequest,
} from '@agentbrowser/engine';
import { SafaridriverError, SafaridriverProcess } from './webdriver.js';

/** One-time safaridriver enablement command surfaced in loud errors. */
export const SAFARIDRIVER_ENABLE_HINT =
  'run `safaridriver --enable` once (requires macOS and user authorization) to allow automated Safari';

interface StoredElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  enabled: boolean;
}

/** Evaluate on the page: tag interactive elements with data-ab-ref and describe them. */
const OBSERVE_SCRIPT = `
  const rev = Number(arguments[0] || 0);
  window.__abRefs = window.__abRefs || {};
  const out = [];
  const nodes = document.querySelectorAll('a, button, input, select, textarea, form, summary, [role], [contenteditable="true"]');
  nodes.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!(rect.width > 0 && rect.height > 0) || style.visibility === 'hidden' || style.display === 'none') return;
    const tag = el.tagName.toLowerCase();
    let role = el.getAttribute('role') || '';
    if (!role) {
      if (tag === 'a') role = 'link';
      else if (tag === 'button') role = 'button';
      else if (tag === 'select') role = 'combobox';
      else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'input') role = el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox';
      else if (tag === 'form') role = 'form';
      else role = 'generic';
    }
    const labels = el.labels ? Array.from(el.labels).map((l) => (l.textContent || '').trim()).join(' ') : '';
    const name = (el.getAttribute('aria-label') || labels || (el.textContent || '') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 120);
    const ref = 'e' + rev + '_' + i;
    el.setAttribute('data-ab-ref', ref);
    window.__abRefs[ref] = el;
    out.push({ ref, role, name, value: 'value' in el ? String(el.value).slice(0, 120) : undefined, enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true' });
  });
  return { title: document.title, url: location.href, bodyText: ((document.body && document.body.innerText) || '').slice(0, 20000), elements: out };
`;

export class SafaridriverEngine implements BrowserEngine {
  readonly name = 'safari';
  readonly version = '1.0.0';
  /** Declared for the contract suite and service-level loud refusal. */
  readonly alwaysHeaded = true;

  private readonly drivers = new Set<SafaridriverProcess>();

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
      supportsAccessibilityTree: true,
      supportsCdp: false,
      supportedObservationModes: ['interactive'],
      supportedActionTypes: ['click', 'fill', 'press', 'scroll'],
      alwaysHeaded: true,
    };
  }

  async createSession(options: EngineSessionOptions): Promise<EngineSession> {
    if (options.requestPolicy !== undefined) {
      throw new SafaridriverError(
        'EGRESS_UNSUPPORTED',
        'Safari via safaridriver cannot intercept network traffic; egress policy is not enforceable on this engine (ADR-006). Use a Chromium session for egress-restricted work.'
      );
    }

    const driver = await SafaridriverProcess.start();
    this.drivers.add(driver);

    let wdSessionId: string;
    try {
      const value = await driver.request<{ sessionId: string }>('/session', 'POST', {
        capabilities: {
          alwaysMatch: {
            browserName: 'safari',
            acceptInsecureCerts: true,
          },
        },
      });
      wdSessionId = value.sessionId;
    } catch (error) {
      driver.kill();
      this.drivers.delete(driver);
      const message = error instanceof Error ? error.message : String(error);
      if (/not.*enabled|enable/i.test(message)) {
        throw new SafaridriverError(
          'SAFARIDRIVER_DISABLED',
          `${message}. ${SAFARIDRIVER_ENABLE_HINT}.`
        );
      }
      throw error;
    }

    const session = new SafariSession(driver, wdSessionId, options, () => {
      driver.kill();
      this.drivers.delete(driver);
    });

    if (options.cookies !== undefined && options.cookies.length > 0) {
      session.queueCookies(options.cookies);
    }
    if (options.viewport !== undefined) {
      await session.setViewport(options.viewport.width, options.viewport.height);
    }
    return session;
  }

  async close(): Promise<void> {
    for (const driver of this.drivers) {
      driver.kill();
    }
    this.drivers.clear();
  }

  /**
   * Availability probe for test gating: true when this machine can drive
   * real Safari (macOS, safaridriver installed AND enabled).
   */
  static async available(): Promise<boolean> {
    if (process.platform !== 'darwin') {
      return false;
    }
    let driver: SafaridriverProcess | undefined;
    try {
      driver = await SafaridriverProcess.start(5_000);
      await driver.request('/session', 'POST', {
        capabilities: { alwaysMatch: { browserName: 'safari' } },
      });
      return true;
    } catch {
      return false;
    } finally {
      driver?.kill();
    }
  }
}

class SafariSession implements EngineSession {
  readonly id: string;
  private readonly pagesMap = new Map<string, SafariPage>();
  private readonly pendingCookieSeeds: NormalizedCookie[] = [];
  private closed = false;

  constructor(
    private readonly driver: SafaridriverProcess,
    wdSessionId: string,
    options: EngineSessionOptions,
    private readonly onSessionGone: () => void
  ) {
    this.id = `safari-${wdSessionId}`;
    void options;
  }

  queueCookies(cookies: NormalizedCookie[]): void {
    this.pendingCookieSeeds.push(...cookies);
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.driver.request(`/session/${this.wdId()}/window/rect`, 'POST', { width, height });
  }

  private wdId(): string {
    return this.id.replace(/^safari-/, '');
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    body?: unknown
  ): Promise<T> {
    return this.driver.request<T>(`/session/${this.wdId()}${path}`, method, body);
  }

  async newPage(_options?: NewPageOptions): Promise<EnginePage> {
    this.assertOpen();
    // Prefer a proper WebDriver new window; fall back to window.open().
    let handle: string;
    try {
      const value = await this.request<{ handle: string }>('/window/new', 'POST', { type: 'tab' });
      handle = value.handle;
    } catch {
      const before = new Set(await this.request<string[]>('/window/handles'));
      await this.request('/execute/sync', 'POST', {
        script: 'window.open("about:blank"); return true;',
        args: [],
      });
      const after = await this.request<string[]>('/window/handles');
      const fresh = after.find((h) => !before.has(h));
      if (fresh === undefined) {
        throw new SafaridriverError('SAFARI_NEW_PAGE_FAILED', 'Safari did not open a new window');
      }
      handle = fresh;
    }
    const page = new SafariPage(this.driver, this.wdId(), handle, this.pendingCookieSeeds, () => {
      this.pagesMap.delete(handle);
    });
    this.pagesMap.set(handle, page);
    await page.switchTo();
    return page;
  }

  async pages(): Promise<EnginePage[]> {
    this.assertOpen();
    const handles = await this.request<string[]>('/window/handles');
    for (const handle of handles) {
      if (!this.pagesMap.has(handle)) {
        const page = new SafariPage(
          this.driver,
          this.wdId(),
          handle,
          this.pendingCookieSeeds,
          () => {
            this.pagesMap.delete(handle);
          }
        );
        this.pagesMap.set(handle, page);
      }
    }
    return Array.from(this.pagesMap.values());
  }

  async cookies(): Promise<NormalizedCookie[]> {
    this.assertOpen();
    const value = await this.request<Array<Record<string, unknown>>>('/cookie');
    return value.map((c) => ({
      name: String(c.name),
      value: String(c.value),
      domain: String(c.domain ?? ''),
      path: String(c.path ?? '/'),
      ...(typeof c.expiry === 'number' ? { expires: c.expiry } : {}),
      httpOnly: c.httpOnly === true,
      secure: c.secure === true,
      sameSite: (c.sameSite as NormalizedCookie['sameSite']) ?? 'Lax',
    })) as NormalizedCookie[];
  }

  async close(_reason?: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.request('', 'DELETE');
    } catch {
      // driver may already be gone; the process kill below is the backstop
    }
    for (const page of this.pagesMap.values()) {
      page.markClosed();
    }
    this.pagesMap.clear();
    this.onSessionGone();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Session is closed');
    }
  }
}

class SafariPage implements EnginePage {
  readonly id: string;
  private revision = 0;
  private lastElements = new Map<string, StoredElement>();
  private closed = false;

  constructor(
    private readonly driver: SafaridriverProcess,
    private readonly wdSessionId: string,
    readonly handle: string,
    private readonly pendingCookieSeeds: NormalizedCookie[],
    private readonly onClosed: () => void
  ) {
    this.id = handle;
  }

  markClosed(): void {
    this.closed = true;
    this.onClosed();
  }

  async switchTo(): Promise<void> {
    await this.driver.request(`/session/${this.wdSessionId}/window`, 'POST', {
      handle: this.handle,
    });
  }

  private async execute<T>(script: string, args: unknown[] = []): Promise<T> {
    await this.switchTo();
    return this.driver.request<T>('/execute/sync', 'POST', { script, args });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Page is closed');
    }
  }

  async navigate(request: NavigationRequest): Promise<NavigationResult> {
    this.assertOpen();
    await this.switchTo();
    await this.driver.request(`/session/${this.wdSessionId}/url`, 'POST', { url: request.url });
    this.revision += 1;

    // TD-BROWSER-7: safaridriver can only set cookies against the active
    // document's origin, so seeded cookies flush after the first navigation
    // (their domain gates which ones apply).
    if (this.pendingCookieSeeds.length > 0) {
      const host = new URL(request.url).hostname;
      const stillPending: NormalizedCookie[] = [];
      for (const cookie of this.pendingCookieSeeds) {
        const applies = host === cookie.domain || host.endsWith(`.${cookie.domain}`);
        if (!applies) {
          stillPending.push(cookie);
          continue;
        }
        try {
          await this.driver.request(`/session/${this.wdSessionId}/cookie`, 'POST', {
            cookie: {
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path || '/',
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              sameSite: cookie.sameSite,
            },
          });
        } catch {
          stillPending.push(cookie);
        }
      }
      this.pendingCookieSeeds.length = 0;
      this.pendingCookieSeeds.push(...stillPending);
    }

    const url = await this.driver
      .request<string>(`/session/${this.wdSessionId}/url`, 'GET')
      .catch(() => request.url);

    return { status: 'success', url, redirectChain: [] };
  }

  async observe(_request: ObservationRequest): Promise<RawPageState> {
    this.assertOpen();
    await this.switchTo();
    this.revision += 1;
    const result = await this.execute<{
      title: string;
      url: string;
      bodyText: string;
      elements: Array<{
        ref: string;
        role: string;
        name: string;
        value?: string;
        enabled: boolean;
      }>;
    }>(OBSERVE_SCRIPT, [this.revision]);

    this.lastElements.clear();
    for (const element of result.elements) {
      this.lastElements.set(element.ref, element);
    }

    return {
      url: result.url,
      title: result.title,
      status: 'complete',
      content: result.bodyText,
      elements: result.elements.map((element) => ({
        ref: element.ref,
        role: element.role,
        ...(element.name ? { name: element.name } : {}),
        ...(element.value ? { value: element.value } : {}),
        visible: true,
        enabled: element.enabled,
      })),
    };
  }

  private descriptorFor(ref: string): StoredElement {
    const descriptor = this.lastElements.get(ref);
    if (descriptor === undefined) {
      throw new Error(
        `Element ref '${ref}' not found in the current observation. Call browser_observe to get fresh refs.`
      );
    }
    return descriptor;
  }

  async resolve(target: EngineTarget): Promise<ResolvedTarget> {
    this.assertOpen();
    const descriptor = this.descriptorFor(target.ref);
    return {
      ref: descriptor.ref,
      fingerprint: `${descriptor.role}_${descriptor.name}_visible_true_enabled_${descriptor.enabled}`,
      role: descriptor.role,
      ...(descriptor.name ? { name: descriptor.name } : {}),
      visible: true,
      enabled: descriptor.enabled,
    };
  }

  async act(
    action: import('@agentbrowser/engine').EngineAction
  ): Promise<import('@agentbrowser/engine').ActionEffect> {
    this.assertOpen();
    await this.switchTo();
    const actionId = `action-${Date.now()}`;
    const oldRevision = this.revision;

    switch (action.type) {
      case 'click': {
        const ref = action.target?.ref;
        if (ref === undefined) {
          throw new Error('click requires a target ref from browser_observe');
        }
        this.descriptorFor(ref);
        const result = await this.execute<{ gone: boolean }>(
          `return (() => {
            const el = (window.__abRefs || {})[${JSON.stringify(
              ref
            )}] || document.querySelector('[data-ab-ref="${ref}"]');
            if (!el) return { gone: true };
            el.click();
            return { gone: false };
          })()`
        );
        if (result.gone) {
          throw new Error(`Element ref '${ref}' not found - the page changed; re-observe.`);
        }
        break;
      }
      case 'fill': {
        const ref = action.target?.ref;
        if (ref === undefined) {
          throw new Error('fill requires a target ref from browser_observe');
        }
        this.descriptorFor(ref);
        const value = String(action.value ?? '');
        await this.execute(
          `return (() => {
            const el = document.querySelector('[data-ab-ref="${ref}"]');
            if (!el) return false;
            el.focus();
            el.value = ${JSON.stringify(value)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()`
        );
        break;
      }
      case 'press': {
        const key = String(action.key ?? 'Enter');
        await this.execute(
          `return (() => {
            const target = document.activeElement || document.body;
            target.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
            target.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(key)}, bubbles: true }));
            return true;
          })()`
        );
        break;
      }
      case 'scroll': {
        const amount = Number(action.amount ?? 600) * (action.direction === 'up' ? -1 : 1);
        await this.execute(
          `window.scrollBy(0, ${Number.isFinite(amount) ? amount : 600}); return true;`
        );
        break;
      }
      default:
        throw new Error(
          `ACTION_UNSUPPORTED: action type '${action.type}' is not supported by the Safari engine`
        );
    }

    this.revision += 1;
    return {
      actionId,
      startTimestamp: new Date(Date.now() - 1).toISOString(),
      endTimestamp: new Date().toISOString(),
      oldRevision,
      newRevision: this.revision,
      result: { type: action.type },
    };
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    this.assertOpen();
    await this.switchTo();
    const data = await this.execute<{ url: string; title: string; text: string; markdown: string }>(
      `return (() => {
        const text = (document.body && document.body.innerText) || '';
        return { url: location.href, title: document.title, text: text.slice(0, 100000), markdown: '# ' + document.title + '\\n\\n' + text.slice(0, 50000) };
      })()`
    );
    void request;
    return { data, evidence: [{ url: data.url, revision: this.revision }] };
  }

  async screenshot(
    request: ScreenshotRequest
  ): Promise<import('@agentbrowser/engine').CapturedArtifact> {
    this.assertOpen();
    await this.switchTo();
    const value = await this.driver.request<string>(
      `/session/${this.wdSessionId}/screenshot`,
      'GET'
    );
    const bytes = Buffer.from(value, 'base64');
    void request;
    return {
      artifactId: `screenshot-${Date.now()}`,
      type: 'screenshot',
      contentType: 'image/png',
      sizeBytes: bytes.length,
      url: `/sessions/${this.wdSessionId}/screenshots/${this.id}`,
      // Production bug fix (same as engine-playwright): this field used
      // to be silently absent, and the service's
      // Buffer.from(undefined ?? '', 'base64') turned every real
      // screenshot into a 0-byte artifact. The driver already returns
      // base64 directly - no re-encoding needed.
      bytesBase64: value,
    };
  }

  async *events(): AsyncIterable<EngineEvent> {
    // Documented gap (TD-BROWSER-7): safaridriver exposes no console or
    // network event stream. The stream stays open for consumers but yields
    // nothing.
    await new Promise(() => {});
  }

  async close(): Promise<void> {
    this.assertOpen();
    this.closed = true;
    try {
      await this.switchTo();
      await this.driver.request(`/session/${this.wdSessionId}/window`, 'DELETE');
    } catch {
      // the window may already be gone
    }
    this.markClosed();
  }
}
