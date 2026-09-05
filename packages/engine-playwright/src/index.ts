/**
 * Playwright Chromium Browser Engine Implementation
 *
 * This implements the BrowserEngine interface using Playwright and Chromium.
 */

import type {
  ActionEffect,
  ArtifactRef,
  BrowserEngine,
  CapturedArtifact,
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
  NormalizedCookie,
  ObservationRequest,
  PdfRequest,
  RawPageState,
  ResolvedTarget,
  ScreenshotRequest,
} from '@agentbrowser/engine';
import type { RequestPolicy } from '@agentbrowser/engine';
import { DELIVERED_ACTION_TYPES, DELIVERED_OBSERVATION_MODES } from '@agentbrowser/protocol';
import { type Browser, type BrowserContext, Locator, type Page, chromium } from 'playwright';

// Re-export engine types
export * from '@agentbrowser/engine';

/** An element captured at observation time, addressable by ref. */
interface StoredElement {
  ref?: string;
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

/** Mutable holder for routing request events out of the egress handler. */
export interface RequestEventSink {
  emit:
    | ((event: {
        type: 'request.started' | 'request.finished' | 'request.failed';
        timestamp: string;
        data: Record<string, unknown>;
        playwrightPage: unknown;
      }) => void)
    | undefined;
}

/**
 * PlaywrightChromiumEngine implements BrowserEngine using Playwright
 */
/** Synthetic denial served to the page for policy-blocked requests. */
const BLOCKED_RESPONSE = {
  status: 403,
  headers: { 'x-agentbrowser-blocked': '1' },
  contentType: 'text/plain',
  body: 'blocked by egress policy',
} as const;

export interface PlaywrightEngineOptions {
  /** Held-dialog auto-settle grace in ms (default 5000). */
  dialogGraceMs?: number;
  /** Browser family: chromium (default), firefox, or webkit. */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /**
   * Remote Chromium over CDP (ws:// or http:// endpoint). When set, the
   * engine connects instead of launching - the spec's RemoteCdpEngine
   * path (browser pools, container isolation). Requires chromium.
   */
  cdpEndpoint?: string;
  /**
   * WebSocket handling. With no egress policy the default is 'off'
   * (upgrades untouched). With egress installed the default becomes
   * 'deny-all': the http choke point's fetch/fulfill proxy breaks page
   * WebSocket connections outright (upstream Playwright limitation,
   * verified empirically), so upgrades are closed cleanly instead of
   * failing opaquely. Selective forwarding (connectToServer) is likewise
   * broken under the proxy - deny-all is the honest shippable gate.
   */
  webSocketPolicy?: 'off' | 'deny-all';
  /**
   * Root egress policy: enforced as a network choke point over EVERY
   * outbound request in every session (documents, redirects,
   * subresources, fetch/XHR). Sessions may override via
   * EngineSessionOptions.requestPolicy.
   */
  egress?: RequestPolicy;
  /**
   * Where a real (branded) Google Chrome binary lives, preferred for HEADED
   * sessions when present (see ADR-013: anti-bot walls flag Playwright's
   * bundled Chromium harder than the branded binary). Defaults to
   * /opt/google/chrome/chrome, overridable via AGENTBROWSER_CHROME_PATH or
   * this option (the option exists mainly so tests can point the probe at a
   * file they control). Headless sessions never consult it.
   */
  chromeBinaryPath?: string;
}

export class PlaywrightChromiumEngine implements BrowserEngine {
  private _name = 'playwright-chromium';
  private _version = '1.0.0';
  private browser: Browser | undefined;
  readonly dialogGraceMs: number;
  private readonly rootEgress: RequestPolicy | undefined;
  private readonly webSocketPolicy: 'off' | 'deny-all';
  private readonly browserFamily: 'chromium' | 'firefox' | 'webkit';
  private readonly cdpEndpoint: string | undefined;
  private readonly chromeBinaryPath: string;

  constructor(options: PlaywrightEngineOptions = {}) {
    this.dialogGraceMs = options.dialogGraceMs ?? 5000;
    this.rootEgress = options.egress;
    this.webSocketPolicy =
      options.webSocketPolicy ?? (options.egress !== undefined ? 'deny-all' : 'off');
    this.browserFamily = options.browser ?? 'chromium';
    this.cdpEndpoint = options.cdpEndpoint;
    this.chromeBinaryPath =
      options.chromeBinaryPath ??
      process.env.AGENTBROWSER_CHROME_PATH ??
      '/opt/google/chrome/chrome';
  }

  get name(): string {
    if (this.cdpEndpoint !== undefined) {
      return 'playwright-chromium-remote';
    }
    return this._name === 'playwright-chromium' && this.browserFamily !== 'chromium'
      ? `playwright-${this.browserFamily}`
      : this._name;
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
      supportedObservationModes: [...DELIVERED_OBSERVATION_MODES],
      // Derived from the protocol single source of truth: drift is
      // impossible by construction.
      supportedActionTypes: [...DELIVERED_ACTION_TYPES],
    };
  }

  async createSession(options: EngineSessionOptions = {}): Promise<EngineSession> {
    // Launch (or connect) the browser family if not already active.
    // TD-BROWSER-6: an explicitly headed session gets a DEDICATED browser.
    // The shared browser is the throughput story for the (default) headless
    // pool; a headed session is an interactive, user-visible artifact whose
    // mode must never be silently overridden by — or override — the shared
    // instance (the old singleton silently launched every later session
    // headless). The dedicated browser is owned by the session and closed
    // with it, so an interactive crash cannot take the pool down.
    let browser: Browser;
    if (this.cdpEndpoint !== undefined) {
      if (this.browserFamily !== 'chromium') {
        throw new Error('cdpEndpoint requires the chromium family');
      }
      if (!this.browser) {
        this.browser = await chromium.connectOverCDP(this.cdpEndpoint);
      }
      browser = this.browser;
    } else if (options.headless === false) {
      browser = await this.launchBrowser(false);
    } else {
      if (!this.browser) {
        this.browser = await this.launchBrowser(true);
      }
      browser = this.browser;
    }

    const egress = options.requestPolicy ?? this.rootEgress;

    // Create browser context (incognito isolation)
    const context = await browser.newContext({
      viewport: options.viewport || { width: 1280, height: 720 },
      locale: options.locale || 'en-US',
      timezoneId: options.timezoneId || 'America/New_York',
      // Service-worker fetches bypass context.route; a choke point with a
      // bypass hole is not a choke point.
      ...(egress !== undefined ? { serviceWorkers: 'block' as const } : {}),
    });
    if (options.headless === false) {
      // Second half of the headed de-fingerprinting (see launchBrowser):
      // navigator.webdriver=true is the single most-checked automation signal.
      await context.addInitScript(
        "Object.defineProperty(navigator, 'webdriver', { get: () => false });"
      );
    }

    // Request-event sink (spec 5.1 network summary, Phase 3): the route
    // handler below emits request.started/finished/failed through this
    // holder; the session routes each event to its originating page so the
    // existing event pipeline (page queue -> service pump -> replay/WS)
    // carries it with no new transport. installEgress runs before any page
    // exists, hence the mutable holder.
    const requestSink: RequestEventSink = { emit: undefined };
    if (egress !== undefined) {
      await this.installEgress(context, egress, requestSink);
    }

    // Seed cookies so a caller can reuse an already-authenticated session
    // (e.g. to skip an SSO / device-trust login the headless browser cannot
    // satisfy). `__Host-`/`__Secure-`-prefixed cookies MUST be host-only and
    // Secure or Chromium silently rejects them; Playwright expresses host-only
    // cookies via `url` (not `domain`/`path`), so convert those here.
    if (options.cookies !== undefined && options.cookies.length > 0) {
      const toAdd = options.cookies.map((c) => {
        if (c.name.startsWith('__Host-')) {
          return {
            name: c.name,
            value: c.value,
            url: `https://${c.domain}/`,
            secure: true,
            ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
            ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
            ...(c.expires !== undefined ? { expires: c.expires } : {}),
          };
        }
        return c;
      });
      await context.addCookies(toAdd as Parameters<typeof context.addCookies>[0]);
    }

    return new PlaywrightSession(
      context,
      this,
      options.headless === false ? browser : undefined,
      requestSink
    );
  }

  /**
   * Launch a browser of the configured family. TD-BROWSER-6: factored out of
   * createSession so headed (dedicated) and headless (shared) launches share
   * one code path.
   */
  private async launchBrowser(headless: boolean): Promise<Browser> {
    const launcher =
      this.browserFamily === 'firefox'
        ? (await import('playwright')).firefox
        : this.browserFamily === 'webkit'
          ? (await import('playwright')).webkit
          : chromium;
    return launcher.launch({
      headless,
      // Headed sessions exist for human-in-the-loop flows (logins, SSO, Cloudflare
      // turnstiles). Playwright's bundled build + navigator.webdriver=true make
      // those challenges loop even with a real display and real clicks — observed
      // live against npmjs.com's turnstile. De-fingerprint headed only (ADR-013):
      // the headless pool keeps its defaults (detection there is honest).
      ...(headless ? {} : await this.headedChromiumOptions()),
    });
  }

  /**
   * Headed-chromium launch options: when the configured binary path exists,
   * launch THAT exact binary via `executablePath` (the API for "use this
   * file" — `channel` resolves through Playwright's own registry and would
   * ignore the path, adversarial-review finding); otherwise fall back to the
   * bundled Chromium. Anti-bot walls flag Playwright's bundled build even
   * headful with real clicks — the branded binary plus the
   * AutomationControlled-disabled flag below is the strongest pass we field.
   * NOT a guarantee: walls that fingerprint the CDP connection itself
   * (Cloudflare turnstile, observed live 2026-09-03: even real Chrome failed)
   * are handled by cookie-seeding instead — see ADR-013.
   */
  private async headedChromiumOptions(): Promise<{
    args: string[];
    executablePath?: string;
  }> {
    const base = {
      // Playwright 1.62 does NOT pass --enable-automation (verified against
      // its default switch list), so there is nothing to ignoreDefaultArgs —
      // the live detectable signal was navigator.webdriver, which the init
      // script rewrites to a real browser's `false`.
      args: ['--disable-blink-features=AutomationControlled'],
    };
    if (this.browserFamily !== 'chromium') return base;
    const hasChrome = await import('node:fs/promises')
      .then((fs) => fs.access(this.chromeBinaryPath))
      .then(
        () => true,
        () => false
      );
    return hasChrome ? { ...base, executablePath: this.chromeBinaryPath } : base;
  }

  /**
   * Network choke point. Every request the context makes - documents,
   * redirect targets, subresources, fetch/XHR - is proxied through the
   * policy: the engine fetches each request itself with redirects NOT
   * followed (route.fetch follows them silently otherwise, which would
   * bypass the choke point - verified empirically), vets every redirect
   * hop's real target hostname, and fulfills the response. Denied hosts
   * (direct or as redirect targets) receive a synthetic 403 marked with
   * x-agentbrowser-blocked, which navigate() maps to `blocked`.
   *
   * Verdicts are memoized per host: policies must keep verdicts a pure
   * function of hostname. Cost: routing disables Chromium's HTTP cache and
   * adds one in-process hop per request (benchmarks re-baselined).
   */
  private async installEgress(
    context: BrowserContext,
    egress: RequestPolicy,
    sink: RequestEventSink
  ): Promise<void> {
    // Verdict cache keys on hostname + resolved-IP set: a changed DNS
    // resolution (rebinding) re-validates instead of replaying a stale
    // allow.
    //
    // Bounded by construction (TD-BROWSER-9, A5): both maps below are local
    // to one installEgress() call, and installEgress() runs once per
    // BrowserContext (one per session). They grow only with the distinct
    // hostnames one session visits and are garbage the moment the context
    // closes - not a general-purpose cache, so no eviction policy is added
    // here on top of the session lifetime bound.
    const verdicts = new Map<string, 'allow' | 'deny'>();
    // Denial reason per hostname (spec 6: "Records allow/deny decisions";
    // ADR-015 B9: engines surface the policy's code/rule, not just 'deny').
    const denyReasons = new Map<string, string>();
    const resolutionCache = new Map<string, string[]>();
    const dns = await import('node:dns/promises');

    const resolveOf = async (hostname: string): Promise<string[]> => {
      // IP literals resolve to themselves.
      if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
        return [hostname];
      }
      try {
        const result = await dns.lookup(hostname, { all: true });
        const addresses = result.map((entry) => entry.address).sort();
        const cached = resolutionCache.get(hostname);
        const key = addresses.join(',');
        if (cached !== undefined && cached.join(',') === key) {
          return cached;
        }
        resolutionCache.set(hostname, addresses);
        // Address-set change invalidates the memoized verdict.
        verdicts.delete(hostname);
        return addresses;
      } catch {
        return []; // resolution failure: hostname checks still apply
      }
    };

    const verdictOf = async (
      hostname: string,
      url: string
    ): Promise<{ verdict: 'allow' | 'deny'; reason?: string }> => {
      const cached = verdicts.get(hostname);
      if (cached !== undefined) {
        const cachedReason = denyReasons.get(hostname);
        return cachedReason !== undefined
          ? { verdict: cached, reason: cachedReason }
          : { verdict: cached };
      }
      let verdict: 'allow' | 'deny';
      let reason: string | undefined;
      try {
        await egress.checkRequest({ hostname, url });
        if (egress.checkResolvedAddresses !== undefined) {
          const addresses = await resolveOf(hostname);
          if (addresses.length > 0) {
            await egress.checkResolvedAddresses(addresses);
          }
        }
        verdict = 'allow';
      } catch (error) {
        verdict = 'deny';
        // Surface the policy's own code/rule instead of flattening to
        // 'deny' (NetworkPolicyError carries both; anything else still
        // gets a readable message).
        const err = error as { code?: string; details?: { rule?: string }; message?: string };
        reason =
          err.code !== undefined
            ? `${err.code}${err.details?.rule !== undefined ? ` (${err.details.rule})` : ''}`
            : (err.message ?? 'denied by egress policy');
        denyReasons.set(hostname, reason);
      }
      verdicts.set(hostname, verdict);
      return reason !== undefined ? { verdict, reason } : { verdict };
    };

    /** Emit a request lifecycle event through the sink (spec 5.1 evidence). */
    const emitRequest = (
      type: 'request.started' | 'request.finished' | 'request.failed',
      request: import('playwright').Request,
      extra: Record<string, unknown>
    ): void => {
      const emit = sink.emit;
      if (emit === undefined) {
        return;
      }
      let playwrightPage: unknown;
      try {
        playwrightPage = request.frame().page();
      } catch {
        return; // frame detached mid-flight; nothing to attribute to
      }
      // URLs carry query-string tokens (spec 14.2): record origin + path,
      // never the query. Deterministic engine-side, no secret registry needed.
      const parsed = new URL(request.url());
      emit({
        type,
        timestamp: new Date().toISOString(),
        playwrightPage,
        data: {
          url: `${parsed.origin}${parsed.pathname}`,
          hostname: parsed.hostname,
          method: request.method(),
          resourceType: request.resourceType(),
          ...extra,
        },
      });
    };

    // WebSocket upgrades bypass context.route entirely. Selective
    // routeWebSocket forwarding (connectToServer) is broken when the http
    // choke point uses route.fetch - verified empirically: ANY fetch/fulfill
    // in context.route makes allowed-WS forwarding fail (upstream Playwright
    // coexistence bug, 1.62.1). The honest, shippable gate is deny-all:
    // when enabled, every upgrade is closed before connecting, closing the
    // WS-based exfiltration residual at the cost of legitimate WebSockets.
    if (this.webSocketPolicy === 'deny-all') {
      const routeWebSocket = (
        context as unknown as {
          routeWebSocket?: (
            pattern: string,
            handler: (ws: {
              close(options?: { code?: number; reason?: string }): Promise<void>;
            }) => void
          ) => Promise<void>;
        }
      ).routeWebSocket;
      if (routeWebSocket !== undefined) {
        await routeWebSocket.call(context, '**', (ws) => {
          void ws.close({ code: 1014, reason: 'blocked by egress policy' });
        });
      }
    }

    await context.route('**', async (route) => {
      const request = route.request();
      const url = request.url();
      const hostname = new URL(url).hostname;

      emitRequest('request.started', request, {});

      const initial = await verdictOf(hostname, url);
      if (initial.verdict === 'deny') {
        emitRequest('request.failed', request, { blocked: true, reason: initial.reason });
        await route.fulfill(BLOCKED_RESPONSE);
        return;
      }

      try {
        const response = await route.fetch({ maxRedirects: 0 });
        const headers = await response.headers();

        // Response-cap enforcement (spec 17): oversized responses are
        // blocked at the choke point, not merely observed.
        if (egress.checkResponse !== undefined) {
          try {
            await egress.checkResponse({ headers });
          } catch {
            emitRequest('request.failed', request, {
              blocked: true,
              reason: 'RESPONSE_TOO_LARGE (response-size cap)',
            });
            await route.fulfill(BLOCKED_RESPONSE);
            return;
          }
        }

        // Actual-byte cap when the size is not declared (chunked/streamed):
        // buffer the body - bounded by the policy's own cap accessor when
        // available - and enforce the true size.
        if (egress.checkBodySize !== undefined && headers['content-length'] === undefined) {
          const body = await response.body();
          try {
            await egress.checkBodySize(body.byteLength);
          } catch {
            emitRequest('request.failed', request, {
              blocked: true,
              reason: 'RESPONSE_TOO_LARGE (actual-byte cap)',
            });
            await route.fulfill(BLOCKED_RESPONSE);
            return;
          }
          emitRequest('request.finished', request, {
            status: response.status(),
            bytes: body.byteLength,
          });
          await route.fulfill({ response, body: body.toString('base64') });
          return;
        }

        const location = headers.location;
        if (response.status() >= 300 && response.status() < 400 && location !== undefined) {
          const absolute = new URL(location, url);
          const hop = await verdictOf(absolute.hostname, absolute.toString());
          if (hop.verdict === 'deny') {
            emitRequest('request.failed', request, {
              blocked: true,
              reason: hop.reason,
              redirect: absolute.origin + absolute.pathname,
            });
            await route.fulfill(BLOCKED_RESPONSE);
            return;
          }
        }
        const declaredLength = headers['content-length'];
        emitRequest('request.finished', request, {
          status: response.status(),
          ...(declaredLength !== undefined ? { bytes: Number.parseInt(declaredLength, 10) } : {}),
        });
        await route.fulfill({ response });
      } catch (error) {
        emitRequest('request.failed', request, {
          blocked: false,
          reason: error instanceof Error ? error.message : 'fetch failed',
        });
        await route.abort('failed');
      }
    });
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = undefined;
    }
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
  /** Completed in-page downloads by suggested filename, per page id. */
  private readonly downloads = new Map<string, Map<string, () => Promise<Buffer>>>();
  private pageCounter = 0;
  private closed = false;

  private ownedBrowser: Browser | undefined;

  /** The page-routing request-event sink installed by createSession. */
  private readonly requestSink: RequestEventSink | undefined;

  constructor(
    context: BrowserContext,
    engine: PlaywrightChromiumEngine,
    ownedBrowser?: Browser,
    requestSink?: RequestEventSink
  ) {
    this.id = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.context = context;
    this.engine = engine;
    this.ownedBrowser = ownedBrowser;
    this.requestSink = requestSink;
    if (requestSink !== undefined) {
      requestSink.emit = (event) => {
        const page = this.pageForPlaywrightPage(event.playwrightPage);
        if (page === undefined) {
          return; // no owning page in this session (or already closed)
        }
        const { playwrightPage: _dropped, ...rest } = event;
        page.emitExternalEvent({
          ...rest,
          sessionId: this.id,
          pageId: page.id,
        });
      };
    }
  }

  /** Find this session's page object backing a raw Playwright page. */
  private pageForPlaywrightPage(candidate: unknown): PlaywrightPage | undefined {
    for (const page of this.pageMap.values()) {
      if (page.backingPage() === candidate) {
        return page;
      }
    }
    return undefined;
  }

  async newPage(options?: NewPageOptions): Promise<EnginePage> {
    if (this.closed) {
      throw new Error('Session is closed');
    }

    const playwrightPage = await this.context.newPage();

    if (options?.viewport) {
      await playwrightPage.setViewportSize(options.viewport);
    }

    const pageId = `page-${this.pageCounter++}`;
    const page = new PlaywrightPage(pageId, playwrightPage, this.engine);
    this.pageMap.set(pageId, page);
    page.registerRemoval(() => this.pageMap.delete(pageId));
    this.downloads.set(pageId, new Map());

    // In-page download interception (spec 10): accept the download, hold
    // its bytes, and surface created/finished events on the page stream.
    playwrightPage.on('download', (download) => {
      const held = this.downloads.get(pageId);
      if (held === undefined) {
        return;
      }
      page.notifyDownloadCreated(download.suggestedFilename());
      const saver = async () => {
        const path = await download.path();
        const { readFile } = await import('node:fs/promises');
        const bytes = path !== null ? await readFile(path) : Buffer.alloc(0);
        held.set(download.suggestedFilename(), () => Promise.resolve(bytes));
        return bytes;
      };
      void saver().then(
        () => page.notifyDownloadFinished(download.suggestedFilename()),
        () => page.notifyDownloadFinished(download.suggestedFilename())
      );
    });

    return page;
  }

  async pages(): Promise<EnginePage[]> {
    return Array.from(this.pageMap.values());
  }

  async cookies(): Promise<NormalizedCookie[]> {
    return (await this.context.cookies()) as NormalizedCookie[];
  }

  /** Bytes of a completed in-page download (by suggested filename). */
  async downloadBytes(pageId: string, filename: string): Promise<Uint8Array | undefined> {
    const held = this.downloads.get(pageId)?.get(filename);
    if (held === undefined) {
      return undefined;
    }
    return new Uint8Array(await held());
  }

  async close(reason?: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Close all pages
    for (const page of this.pageMap.values()) {
      await page.close();
    }
    this.pageMap.clear();

    // Close context
    await this.context.close();

    // TD-BROWSER-6: a headed session owns its browser; dispose it. Failure to
    // close must not fail the session close (the OS reaps the process).
    if (this.ownedBrowser !== undefined) {
      try {
        await this.ownedBrowser.close();
      } catch {
        // already gone or unresponsive; nothing further to release
      }
      this.ownedBrowser = undefined;
    }
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
  private removeSelf: () => void = () => {};
  private pendingDialog: { dialog: import('playwright').Dialog; timer: NodeJS.Timeout } | undefined;
  /**
   * Handler references for the four listeners setupEventListeners() attaches
   * (hygiene D1): removed by name in close(), NOT via page.removeAllListeners()
   * - that strips Playwright's own internally-attached page listeners too,
   * which raced context-level route handlers into an unhandled
   * "route.abort: ...has been closed" rejection during teardown (caught by
   * the Obscura CDP suite, which shares this same PlaywrightPage).
   */
  private onPageClose: () => void = () => {};
  private onPageDialog: (dialog: import('playwright').Dialog) => void = () => {};
  private onPageLoad: () => void = () => {};
  private onPageConsole: (msg: import('playwright').ConsoleMessage) => void = () => {};

  /** Registered by the owning session so close() removes it from the map. */
  registerRemoval(remove: () => void): void {
    this.removeSelf = remove;
  }

  /** The raw Playwright page backing this engine page (request-event routing). */
  backingPage(): Page {
    return this.page;
  }

  /**
   * Enqueue an event originating OUTSIDE this page (the egress handler's
   * request lifecycle events, routed here by the session). Stamps nothing:
   * the caller provides sessionId/pageId.
   */
  emitExternalEvent(event: EngineEvent): void {
    this.enqueueEvent(event);
  }

  constructor(id: string, page: Page, engine: PlaywrightChromiumEngine) {
    this.id = id;
    this.page = page;
    this.engine = engine;

    // Setup event listeners
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // The browser can close pages without PlaywrightPage.close() running
    // (engine.close()); Playwright's own close event ends the iterator.
    this.onPageClose = () => {
      this.eventsClosed = true;
      const waiters = this.eventWaiters;
      this.eventWaiters = [];
      for (const wake of waiters) {
        wake();
      }
    };
    this.page.on('close', this.onPageClose);

    this.onPageDialog = (dialog) => {
      // Hold the dialog so an agent can accept or dismiss it; settle it
      // automatically after the grace (beforeunload auto-accepts because
      // dismissing cancels the navigation).
      const isBeforeUnload = dialog.type() === 'beforeunload';
      const timer = setTimeout(() => {
        void (isBeforeUnload ? dialog.accept().catch(() => {}) : dialog.dismiss().catch(() => {}));
        this.pendingDialog = undefined;
        this.enqueueEvent({
          type: 'dialog.closed',
          timestamp: new Date().toISOString(),
          sessionId: 'unknown',
          pageId: this.id,
          data: { reason: 'auto', dialogType: dialog.type(), message: dialog.message() },
        });
      }, this.engine.dialogGraceMs);

      this.pendingDialog = { dialog, timer };
      this.enqueueEvent({
        type: 'dialog.opened',
        timestamp: new Date().toISOString(),
        sessionId: 'unknown',
        pageId: this.id,
        data: {
          dialogType: dialog.type(),
          message: dialog.message(),
          defaultPrompt: dialog.defaultValue(),
        },
      });
    };
    this.page.on('dialog', this.onPageDialog);

    this.onPageLoad = () => {
      this.enqueueEvent({
        type: 'page.loaded',
        timestamp: new Date().toISOString(),
        sessionId: 'unknown', // Stamped by the service
        pageId: this.id,
      });
    };
    this.page.on('load', this.onPageLoad);

    this.onPageConsole = (msg) => {
      this.enqueueEvent({
        type: msg.type() as never,
        timestamp: new Date().toISOString(),
        sessionId: 'unknown',
        pageId: this.id,
        data: { text: msg.text() },
      });
    };
    this.page.on('console', this.onPageConsole);
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
    const response = await this.page.goto(request.url, {
      waitUntil: waitUntil as 'load' | 'domcontentloaded' | 'networkidle',
    });
    // The choke point serves a marked 403 for denied navigations and
    // denied redirect targets alike (hygiene E3: every deny path in
    // installEgress uses route.fulfill(BLOCKED_RESPONSE), never
    // route.abort() - the header is the only signal a denial ever
    // produces, so it's also the only one worth matching on. A prior
    // String(error)-regex fallback here for 'ERR_BLOCKED_BY_CLIENT'/
    // 'net::ERR_ABORTED' didn't match anything installEgress's own
    // abort() call actually throws (that's reason 'failed', i.e.
    // net::ERR_FAILED, and represents a genuine fetch failure, not a
    // policy decision - it must propagate as a real error). Its only
    // live effect was silently relabeling any unrelated real navigation
    // abort as a policy block.
    if (response?.headers()?.['x-agentbrowser-blocked'] === '1') {
      return {
        status: 'blocked',
        url: request.url,
        redirectChain: [],
      };
    }
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
    let elements: StoredElement[] = [];

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
    for (const [index, element] of elements.entries()) {
      this.refStore.set(element.ref ?? `e${this.revision}_${index}`, {
        role: element.role,
        ...(element.name !== undefined ? { name: element.name } : {}),
        ...(element.value !== undefined ? { value: element.value } : {}),
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
  private parseAriaSnapshot(yaml: string, revision: number): StoredElement[] {
    const elements: StoredElement[] = [];
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

      const element: StoredElement = {
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

  private async getContentElements(): Promise<StoredElement[]> {
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

    const elements: StoredElement[] = [];

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

  async resolve(target: EngineTarget): Promise<ResolvedTarget> {
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
      case 'acceptDialog':
      case 'dismissDialog': {
        // Dialog actions are non-mutating and act on the held Dialog
        // directly: locators stall while a dialog is open.
        const held = this.pendingDialog;
        if (!held) {
          throw new Error('no dialog open');
        }
        clearTimeout(held.timer);
        this.pendingDialog = undefined;
        if (action.type === 'acceptDialog') {
          await held.dialog.accept(action.promptText as string | undefined);
        } else {
          await held.dialog.dismiss();
        }
        this.enqueueEvent({
          type: 'dialog.closed',
          timestamp: new Date().toISOString(),
          sessionId: 'unknown',
          pageId: this.id,
          data: {
            reason: action.type === 'acceptDialog' ? 'accepted' : 'dismissed',
            dialogType: held.dialog.type(),
          },
        });
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
      case 'dblclick': {
        const locator = this.locatorFor((action.target as EngineTarget).ref);
        await locator.dblclick();
        this.bumpRevision();
        break;
      }
      case 'hover': {
        // Hover is non-mutating observation support: no revision bump, so
        // refs live across it.
        const locator = this.locatorFor((action.target as EngineTarget).ref);
        await locator.hover();
        break;
      }
      case 'clear': {
        const locator = this.locatorFor((action.target as EngineTarget).ref);
        await locator.fill('');
        this.bumpRevision();
        break;
      }
      case 'check':
      case 'uncheck': {
        const locator = this.locatorFor((action.target as EngineTarget).ref);
        if (action.type === 'check') {
          await locator.check();
        } else {
          await locator.uncheck();
        }
        this.bumpRevision();
        break;
      }
      case 'wait': {
        // Non-mutating; bounded by the condition's timeout.
        const condition = action.condition as { until?: string; timeoutMs?: number };
        const state = condition?.until === 'networkidle' ? 'networkidle' : 'load';
        await this.waitForLoadState(state, { timeout: condition?.timeoutMs });
        break;
      }
      case 'goBack':
      case 'goForward': {
        const response =
          action.type === 'goBack' ? await this.page.goBack() : await this.page.goForward();
        if (response !== null) {
          this.bumpRevision();
        }
        break;
      }
      case 'reload': {
        await this.page.reload();
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

  async screenshot(request: ScreenshotRequest): Promise<CapturedArtifact> {
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
      // Production bug fix: this field used to be silently absent, and
      // the service's Buffer.from(undefined ?? '', 'base64') turned every
      // real screenshot into a 0-byte artifact. See CapturedArtifact's doc.
      bytesBase64: screenshot.toString('base64'),
    };
  }

  async pdf(request: PdfRequest): Promise<CapturedArtifact> {
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

  /** Emit download.created/finished into the event stream. */
  notifyDownloadCreated(filename: string): void {
    this.enqueueEvent({
      type: 'download.created',
      timestamp: new Date().toISOString(),
      sessionId: 'unknown',
      pageId: this.id,
      data: { filename },
    });
  }

  notifyDownloadFinished(filename: string): void {
    this.enqueueEvent({
      type: 'download.finished',
      timestamp: new Date().toISOString(),
      sessionId: 'unknown',
      pageId: this.id,
      data: { filename },
    });
  }

  /**
   * Wait for a browser load state (spec 11.1). Real waits on the real
   * engine; the service maps missed deadlines to ACTION_TIMEOUT.
   */
  async waitForLoadState(
    state: 'load' | 'domcontentloaded' | 'networkidle',
    options: { timeout?: number | undefined } = {}
  ): Promise<void> {
    await this.page.waitForLoadState(state, {
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    });
  }

  async close(): Promise<void> {
    this.eventsClosed = true;
    this.removeSelf();
    if (this.pendingDialog) {
      clearTimeout(this.pendingDialog.timer);
      this.pendingDialog = undefined;
    }
    const waiters = this.eventWaiters;
    this.eventWaiters = [];
    for (const wake of waiters) {
      wake();
    }
    // Hygiene D1: the constructor attaches 'close'/'dialog'/'load'/'console'
    // listeners (setupEventListeners) that were never explicitly removed -
    // a session churning many pages accumulated handler stubs on each
    // Playwright Page object until it was GC'd. Removed by name (not
    // page.removeAllListeners()) so Playwright's own internally-attached
    // page listeners survive - stripping those raced a context-level
    // route handler into an unhandled "route.abort: ...has been closed"
    // rejection during teardown (caught by the Obscura CDP suite).
    this.page.off('close', this.onPageClose);
    this.page.off('dialog', this.onPageDialog);
    this.page.off('load', this.onPageLoad);
    this.page.off('console', this.onPageConsole);
    await this.page.close();
  }
}
