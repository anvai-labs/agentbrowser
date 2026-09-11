/**
 * Playwright Chromium Browser Engine Implementation
 *
 * This implements the BrowserEngine interface using Playwright and Chromium.
 */

import { randomUUID } from 'node:crypto';
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
  OverlayBlocker,
  PdfRequest,
  RawPageState,
  ResolvedTarget,
  ScreenshotRequest,
} from '@agentbrowser/engine';
import type { RequestPolicy } from '@agentbrowser/engine';
import { EngineError, normalizeEngineError } from '@agentbrowser/engine';
import { DELIVERED_ACTION_TYPES, DELIVERED_OBSERVATION_MODES } from '@agentbrowser/protocol';
import {
  type Browser,
  type BrowserContext,
  type ElementHandle,
  type Locator,
  type Page,
  chromium,
} from 'playwright';
import {
  SnapshotBudget,
  type SnapshotEvidence,
  sameSnapshotEvidence,
  snapshotDigest,
  snapshotTimeout,
} from './snapshot-evidence.js';

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
  href?: string;
  hrefTruncated?: boolean;
}

interface NodeBinding extends SnapshotEvidence {
  handle: ElementHandle;
  locator: Locator;
}

/** Strip surrounding quotes and unescape from an aria snapshot value. */
function unquote(value: string): string {
  const trimmed = value.trim();
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed);
  return match?.[1] !== undefined ? match[1] : trimmed;
}

/** Bound a diagnostic promise; Playwright evaluate has no timeout of its own. */
async function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadline exceeded')), deadlineMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
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
   * broken under the proxy. Coverage is limited to Playwright's page
   * WebSocket routing; this is not a transport-wide containment guarantee.
   */
  webSocketPolicy?: 'off' | 'deny-all';
  /**
   * Root policy for routed requests in every session. Initial requests
   * and their first redirect targets are checked; later redirect hops
   * bypass Playwright routing. DNS checks do not pin browser connections.
   * Sessions may override via EngineSessionOptions.requestPolicy.
   */
  egress?: RequestPolicy;
  /**
   * Explicit override for the HEADED-session browser binary (see ADR-013,
   * ADR-016). When set — here or via AGENTBROWSER_CHROME_PATH — detection is
   * skipped entirely: an existing path launches that exact binary, a missing
   * path falls back to bundled (no guessing behind an explicit answer).
   * When unset, headed chromium launches prefer the first existing
   * well-known branded-Chrome path (ADR-016 detection). Headless sessions
   * never consult any of this.
   */
  chromeBinaryPath?: string;
  /**
   * Skip branded-Chrome detection for headed launches and use the bundled
   * Chromium (ADR-016 escape hatch for CI / determinism). Does not defeat an
   * explicit chromeBinaryPath. Environment fallback:
   * AGENTBROWSER_PREFER_BUNDLED=1|true.
   */
  preferBundled?: boolean;
  /**
   * Candidate paths probed in order for branded-Chrome detection when no
   * explicit chromeBinaryPath is set and preferBundled is false (ADR-016).
   * Injectable so tests can point the probe at files they control.
   */
  brandedChromeCandidates?: string[];
  /**
   * Shared snapshot-wait budget per observation and timeout per action-time
   * semantic check (1..30000 ms, default 1000; environment fallback via
   * AGENTBROWSER_SNAPSHOT_TIMEOUT_MS). Timed-out element captures use successful
   * whole-document evidence, never DOM identity alone. Other observation work
   * is not covered by this budget.
   */
  snapshotTimeoutMs?: number;
}

/**
 * ADR-016 context viewport policy: an explicit viewport always pins;
 * otherwise headless keeps the historical 1280x720 while headed renders
 * window-true (viewport null + --start-maximized) so the browser looks and
 * lays out like a real user's window — fingerprints care about both.
 */
export function resolveContextViewport(
  explicit: { width: number; height: number } | undefined,
  headless: boolean
): { width: number; height: number } | null {
  return explicit ?? (headless ? { width: 1280, height: 720 } : null);
}

function defaultBrandedChromeCandidates(): string[] {
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    return [
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
}

function preferBundledEnv(): boolean {
  const value = process.env.AGENTBROWSER_PREFER_BUNDLED;
  return value === '1' || value === 'true';
}

export class PlaywrightChromiumEngine implements BrowserEngine {
  private _name = 'playwright-chromium';
  private _version = '1.0.0';
  private browser: Browser | undefined;
  readonly dialogGraceMs: number;
  private readonly rootEgress: RequestPolicy | undefined;
  private readonly webSocketPolicy: 'off' | 'deny-all' | undefined;
  private readonly browserFamily: 'chromium' | 'firefox' | 'webkit';
  private readonly cdpEndpoint: string | undefined;
  private readonly chromeBinaryPath: string | undefined;
  private readonly preferBundled: boolean;
  private readonly brandedChromeCandidates: string[];
  readonly snapshotTimeoutMs: number;

  constructor(options: PlaywrightEngineOptions = {}) {
    this.dialogGraceMs = options.dialogGraceMs ?? 5000;
    this.rootEgress = options.egress;
    this.webSocketPolicy = options.webSocketPolicy;
    this.browserFamily = options.browser ?? 'chromium';
    this.cdpEndpoint = options.cdpEndpoint;
    this.chromeBinaryPath = options.chromeBinaryPath ?? process.env.AGENTBROWSER_CHROME_PATH;
    this.preferBundled = options.preferBundled ?? preferBundledEnv();
    this.brandedChromeCandidates =
      options.brandedChromeCandidates ?? defaultBrandedChromeCandidates();
    this.snapshotTimeoutMs = snapshotTimeout(options.snapshotTimeoutMs);
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
    const headless = options.headless !== false;
    let browser: Browser;
    if (this.cdpEndpoint !== undefined) {
      if (this.browserFamily !== 'chromium') {
        throw new Error('cdpEndpoint requires the chromium family');
      }
      if (!this.browser) {
        this.browser = await chromium.connectOverCDP(this.cdpEndpoint);
      }
      browser = this.browser;
    } else if (!headless) {
      browser = await this.launchBrowser(false, options.viewport === undefined);
    } else {
      if (!this.browser) {
        this.browser = await this.launchBrowser(true, false);
      }
      browser = this.browser;
    }

    const egress = options.requestPolicy ?? this.rootEgress;

    // Create browser context (incognito isolation)
    const context = await browser.newContext({
      viewport: resolveContextViewport(options.viewport, headless),
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
      requestSink,
      options.downloadPolicy
    );
  }

  /**
   * Launch a browser of the configured family. TD-BROWSER-6: factored out of
   * createSession so headed (dedicated) and headless (shared) launches share
   * one code path.
   */
  private async launchBrowser(headless: boolean, startMaximized: boolean): Promise<Browser> {
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
      ...(headless ? {} : await this.headedChromiumOptions(startMaximized)),
    });
  }

  /**
   * Headed-chromium launch options (ADR-016). Binary precedence: explicit
   * chromeBinaryPath / AGENTBROWSER_CHROME_PATH (probed; missing → bundled,
   * no detection behind an explicit answer) > first existing well-known
   * branded-Chrome path > bundled Chromium, with preferBundled skipping
   * detection. The winner is logged so a mis-detected install is debuggable
   * from the service log alone. An existing explicit path launches THAT
   * exact binary via `executablePath` (the API for "use this file" —
   * `channel` resolves through Playwright's own registry and would ignore
   * the path, adversarial-review finding). Anti-bot walls flag Playwright's
   * bundled build even headful with real clicks — the branded binary plus
   * the AutomationControlled-disabled flag below is the strongest pass we
   * field. NOT a guarantee: walls that fingerprint the CDP connection
   * itself (Cloudflare turnstile, observed live 2026-09-03: even real
   * Chrome failed) are handled by cookie-seeding instead — see ADR-013.
   */
  private async headedChromiumOptions(startMaximized = false): Promise<{
    args: string[];
    executablePath?: string;
  }> {
    // Playwright 1.62 does NOT pass --enable-automation (verified against
    // its default switch list), so there is nothing to ignoreDefaultArgs —
    // the live detectable signal was navigator.webdriver, which the init
    // script rewrites to a real browser's `false`.
    const args = ['--disable-blink-features=AutomationControlled'];
    if (this.browserFamily !== 'chromium') return { args };
    const resolved = await this.resolveHeadedExecutable();
    console.info(`[agentbrowser] headed chromium binary: ${resolved ?? 'bundled Chromium'}`);
    return {
      args: startMaximized ? [...args, '--start-maximized'] : args,
      ...(resolved !== undefined ? { executablePath: resolved } : {}),
    };
  }

  /**
   * ADR-016 headed-binary precedence. Detection (branded candidates) runs
   * only when no explicit path is set and preferBundled is false.
   */
  private async resolveHeadedExecutable(): Promise<string | undefined> {
    const fs = await import('node:fs/promises');
    if (this.chromeBinaryPath !== undefined) {
      try {
        await fs.access(this.chromeBinaryPath);
        return this.chromeBinaryPath;
      } catch {
        return undefined;
      }
    }
    if (this.preferBundled) return undefined;
    for (const candidate of this.brandedChromeCandidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // candidate absent — keep probing
      }
    }
    return undefined;
  }

  /**
   * Partial browser egress gate. For each routed request, fetch without
   * following redirects, check the response and first Location target,
   * then fulfill. Playwright does not route later hops in that chain;
   * this path does not enforce all-hop host, redirect-count or byte limits.
   * Denied routed requests receive a synthetic 403 marked with
   * x-agentbrowser-blocked, which navigate() maps to `blocked`.
   *
   * Verdicts and addresses are rechecked per routed request, but the
   * browser connection is not DNS-pinned. Body checks occur after buffering.
   * Routing disables Chromium's HTTP cache and adds an in-process hop.
   */
  private async installEgress(
    context: BrowserContext,
    egress: RequestPolicy,
    sink: RequestEventSink
  ): Promise<void> {
    // Validate each request afresh. Host memoization hid DNS changes and
    // retained an unbounded set of names in long-lived sessions.
    const dns = await import('node:dns/promises');

    const resolveOf = async (hostname: string): Promise<string[]> => {
      // IP literals resolve to themselves.
      if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
        return [hostname];
      }
      try {
        const result = await dns.lookup(hostname, { all: true });
        return result.map((entry) => entry.address);
      } catch {
        throw new EngineError('POLICY_DENIED', 'Cannot validate unresolved hostname');
      }
    };

    const verdictOf = async (
      hostname: string,
      url: string
    ): Promise<{ verdict: 'allow' | 'deny'; reason?: string }> => {
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
      }
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
    // coexistence bug, 1.62.1). Close upgrades intercepted by Playwright's
    // page routing. Do not infer worker coverage or network containment
    // from a page-level deny fixture; those need independent verification.
    if (this.webSocketPolicy !== 'off') {
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

      // Playwright marks a terminal route operation handled before awaiting
      // transport completion. A failed fulfill/dispose must not abort it again.
      let terminalStarted = false;
      const fulfill = (options: Parameters<typeof route.fulfill>[0]) => {
        terminalStarted = true;
        return route.fulfill(options);
      };

      try {
        const initial = await verdictOf(hostname, url);
        if (initial.verdict === 'deny') {
          emitRequest('request.failed', request, { blocked: true, reason: initial.reason });
          await fulfill(BLOCKED_RESPONSE);
          return;
        }
        const response = await route.fetch({ maxRedirects: 0 });
        try {
          const headers = await response.headers();
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
              await fulfill(BLOCKED_RESPONSE);
              return;
            }
          }

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
              await fulfill(BLOCKED_RESPONSE);
              return;
            }
          }

          // Playwright buffers route.fetch before this gate; this limits what
          // reaches the page, NOT peak transport memory (ADR-008 residual).
          if (egress.checkBodySize !== undefined) {
            const body = await response.body();
            try {
              await egress.checkBodySize(body.byteLength);
            } catch {
              emitRequest('request.failed', request, {
                blocked: true,
                reason: 'RESPONSE_TOO_LARGE (actual-byte cap)',
              });
              await fulfill(BLOCKED_RESPONSE);
              return;
            }
            emitRequest('request.finished', request, {
              status: response.status(),
              bytes: body.byteLength,
            });
            await fulfill({ response, body });
            return;
          }

          const declaredLength = headers['content-length'];
          emitRequest('request.finished', request, {
            status: response.status(),
            ...(declaredLength !== undefined ? { bytes: Number.parseInt(declaredLength, 10) } : {}),
          });
          await fulfill({ response });
        } finally {
          await response.dispose();
        }
      } catch (error) {
        emitRequest('request.failed', request, {
          blocked: false,
          reason: error instanceof Error ? error.message : 'fetch failed',
        });
        if (!terminalStarted) {
          // Best effort after recording the failure: the context may already
          // be closed, in which case abort itself rejects too.
          await route.abort('failed').catch(() => {});
        }
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
  private readonly downloads = new Map<
    string,
    {
      entries: Map<string, { downloadId: string; filename: string; bytes: Uint8Array }>;
      bytes: number;
    }
  >();
  private pageCounter = 0;
  private closed = false;

  private ownedBrowser: Browser | undefined;

  /** The page-routing request-event sink installed by createSession. */
  private readonly requestSink: RequestEventSink | undefined;

  constructor(
    context: BrowserContext,
    engine: PlaywrightChromiumEngine,
    ownedBrowser?: Browser,
    requestSink?: RequestEventSink,
    private readonly downloadPolicy: EngineSessionOptions['downloadPolicy'] = {
      allow: true,
      maxBytes: 10 * 1024 * 1024,
    }
  ) {
    this.id = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.context = context;
    this.engine = engine;
    this.ownedBrowser = ownedBrowser;
    this.requestSink = requestSink;
    // F10: pages the browser opens on its own (window.open) still belong to
    // this session; pages opened via newPage() have no opener and are
    // skipped inside the handler.
    this.context.on('page', (page) => {
      void this.adoptPopupPage(page);
    });
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

  /**
   * F10: adopt a page the browser created on its own (window.open). Pages
   * opened via newPage() have no opener and are skipped, so this listener
   * can sit on the context for the session's lifetime. The opener's event
   * stream announces page.created with engine page ids; the service adopts
   * from there.
   */
  private async adoptPopupPage(playwrightPage: Page): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      const opener = await playwrightPage.opener();
      if (opener === null) {
        return;
      }
      const popup = await this.registerPlaywrightPage(playwrightPage);
      const openerPage = this.pageForPlaywrightPage(opener);
      openerPage?.emitExternalEvent({
        type: 'page.created',
        timestamp: new Date().toISOString(),
        sessionId: this.id,
        pageId: popup.id,
        data: { openerPageId: openerPage.id, pageId: popup.id, url: playwrightPage.url() },
      });
    } catch {
      // Adoption is best-effort; an unadoptable popup stays browser-side.
    }
  }

  async newPage(options?: NewPageOptions): Promise<EnginePage> {
    if (this.closed) {
      throw new Error('Session is closed');
    }
    const playwrightPage = await this.context.newPage();
    return this.registerPlaywrightPage(playwrightPage, options?.viewport);
  }

  private async registerPlaywrightPage(
    playwrightPage: Page,
    viewport?: NewPageOptions['viewport']
  ): Promise<PlaywrightPage> {
    if (viewport) {
      await playwrightPage.setViewportSize(viewport);
    }

    const pageId = `page-${this.pageCounter++}`;
    const page = new PlaywrightPage(pageId, playwrightPage, this.engine);
    this.pageMap.set(pageId, page);
    page.registerRemoval(() => {
      this.pageMap.delete(pageId);
      this.downloads.delete(pageId);
      playwrightPage.off('download', onDownload);
    });
    this.downloads.set(pageId, { entries: new Map(), bytes: 0 });

    // In-page download interception (spec 10): accept the download, hold
    // its bytes, and surface created/finished events on the page stream.
    const onDownload = (download: import('playwright').Download) => {
      const held = this.downloads.get(pageId);
      if (held === undefined) {
        return;
      }
      const downloadId = `dl_${randomUUID()}`;
      const filename = download.suggestedFilename();
      page.notifyDownloadCreated(filename, downloadId);
      const saver = async () => {
        if (!this.downloadPolicy?.allow) {
          await download.cancel();
          throw new EngineError('DOWNLOAD_BLOCKED', 'Downloads are disabled');
        }
        const path = await download.path();
        if (path === null || (await download.failure()))
          throw new EngineError('DOWNLOAD_BLOCKED', 'Browser download failed');
        if (this.downloads.get(pageId) !== held) return;
        const { readFile, stat } = await import('node:fs/promises');
        const size = (await stat(path)).size;
        if (size > this.downloadPolicy.maxBytes || size > 20 * 1024 * 1024)
          throw new EngineError('DOWNLOAD_BLOCKED', 'Captured download exceeds the byte limit');
        const bytes = await readFile(path);
        if (this.downloads.get(pageId) !== held) return;
        while (held.entries.size >= 100 || held.bytes + bytes.byteLength > 20 * 1024 * 1024) {
          const oldest = held.entries.values().next().value;
          if (!oldest) break;
          held.bytes -= oldest.bytes.byteLength;
          held.entries.delete(oldest.downloadId);
        }
        held.entries.set(downloadId, { downloadId, filename, bytes });
        held.bytes += bytes.byteLength;
        page.notifyDownloadFinished(filename, downloadId);
      };
      void saver()
        .catch((error) =>
          page.emitExternalEvent({
            type: 'download.failed',
            timestamp: new Date().toISOString(),
            sessionId: this.id,
            pageId,
            data: { downloadId, filename, code: normalizeEngineError(error).code },
          })
        )
        .finally(() => download.delete().catch(() => {}));
    };
    playwrightPage.on('download', onDownload);

    return page;
  }

  async pages(): Promise<EnginePage[]> {
    return Array.from(this.pageMap.values());
  }

  async cookies(): Promise<NormalizedCookie[]> {
    return (await this.context.cookies()) as NormalizedCookie[];
  }

  /** Bytes of a completed in-page download (by suggested filename). */
  async takeDownload(pageId: string, id: string) {
    const held = this.downloads.get(pageId);
    if (!held) return undefined;
    const direct = held.entries.get(id);
    const matches = direct
      ? [direct]
      : [...held.entries.values()].filter((entry) => entry.filename === id);
    if (matches.length > 1)
      throw new EngineError(
        'INVALID_REQUEST',
        'Ambiguous download filename; collect by downloadId'
      );
    const entry = matches[0];
    if (!entry) return undefined;
    held.entries.delete(entry.downloadId);
    held.bytes -= entry.bytes.byteLength;
    return entry;
  }

  /** Legacy adapter helper; the service uses the typed consuming port. */
  async downloadBytes(pageId: string, filename: string): Promise<Uint8Array | undefined> {
    return (await this.takeDownload(pageId, filename))?.bytes;
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
    this.downloads.clear();

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
  private bindings = new Map<string, NodeBinding>();
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
  private onPageCrashed: () => void = () => {};

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

    // F10: a renderer crash reaches subscribers as the declared-but-never-
    // emitted page.crashed event; the service records it in the replay.
    this.onPageCrashed = () => {
      this.enqueueEvent({
        type: 'page.crashed',
        timestamp: new Date().toISOString(),
        sessionId: 'unknown',
        pageId: this.id,
      });
    };
    this.page.on('crash', this.onPageCrashed);

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

  async getUrl(): Promise<string> {
    if (this.page.isClosed()) throw new EngineError('PAGE_NOT_FOUND', 'Page is closed');
    return this.page.url();
  }

  getCachedUrl(): string | undefined {
    return this.page.isClosed() ? undefined : this.page.url();
  }

  async navigate(request: NavigationRequest): Promise<NavigationResult> {
    try {
      return await this.performNavigation(request);
    } catch (error) {
      const failure = normalizeEngineError(error, 'navigate');
      throw new EngineError(failure.code, failure.message, failure.retryable, failure.details);
    }
  }

  private async performNavigation(request: NavigationRequest): Promise<NavigationResult> {
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
    this.releaseRefs();
  }

  private releaseRefs(): void {
    for (const { handle } of this.bindings.values()) {
      // Disposal is best effort after document/context teardown.
      void handle.dispose().catch(() => {});
    }
    this.bindings.clear();
    this.refStore.clear();
  }

  async observe(request: ObservationRequest): Promise<RawPageState> {
    const mode = request.mode || 'interactive';
    const snapshotBudget = new SnapshotBudget(this.engine.snapshotTimeoutMs);
    let documentSnapshot: string | undefined;

    // Get accessibility tree if requested
    let elements: StoredElement[] = [];

    if (mode === 'interactive' || mode === 'accessibility' || mode === 'content') {
      // Only timeouts can recover. Transport/context errors are not evidence.
      const yaml = await snapshotBudget.capture(this.page.locator('body'));
      documentSnapshot = snapshotDigest(yaml);
      if (yaml !== undefined) {
        elements = this.parseAriaSnapshot(yaml, this.revision);
      } else {
        elements = await this.getContentElements();
      }
    }

    // Rebuild the ref store from this observation: refs are deterministic
    // within a revision (document order), so the same element maps to the
    // same ref until the page mutates.
    const previous = this.bindings;
    const previousCount = this.refStore.size;
    this.bindings = new Map();
    this.refStore.clear();
    let changed = previousCount > 0 && previousCount !== elements.length;
    const ordinals = new Map<string, number>();
    // href capture is one round-trip per link; bound it so link-heavy pages
    // cannot stretch an observation unboundedly.
    let hrefCaptures = 0;
    try {
      for (const [index, element] of elements.entries()) {
        const ref = element.ref ?? `e${this.revision}_${index}`;
        const key = JSON.stringify([element.role, element.name ?? '']);
        const ordinal = ordinals.get(key) ?? 0;
        ordinals.set(key, ordinal + 1);
        const locator = this.page
          .getByRole(element.role as never, { name: element.name ?? '', exact: true })
          .nth(ordinal);
        // Bind once to an actual node. An ordinal is never resolved anew at act time.
        if (await locator.count()) {
          const handle = await locator.elementHandle();
          if (handle) {
            // Register the handle before more I/O so a capture failure releases it.
            const binding: NodeBinding = {
              handle,
              locator,
              snapshot: undefined,
              documentSnapshot,
            };
            this.bindings.set(ref, binding);
            binding.snapshot = snapshotDigest(await snapshotBudget.capture(locator));
            const prior = previous.get(ref);
            if (
              previous.size > 0 &&
              (!prior ||
                !(await handle
                  .evaluate((node, old) => node.isSameNode(old), prior.handle)
                  .catch(() => false)) ||
                !sameSnapshotEvidence(prior, binding))
            )
              changed = true;
            element.visible = await handle.isVisible();
            element.enabled = await handle.isEnabled();
            if (element.role === 'link' && hrefCaptures < 50) {
              const href = await locator.getAttribute('href').catch(() => undefined);
              if (typeof href === 'string' && href !== '') {
                hrefCaptures += 1;
                element.href = href.slice(0, 2048);
                if (href.length > 2048) {
                  element.hrefTruncated = true;
                }
              }
            }
          }
        }
        this.refStore.set(ref, {
          role: element.role,
          ...(element.name !== undefined ? { name: element.name } : {}),
          ...(element.value !== undefined ? { value: element.value } : {}),
          visible: element.visible,
          enabled: element.enabled,
        });
      }
    } catch (error) {
      // Never expose a partly rebuilt set of refs after capture/context failure.
      this.bumpRevision();
      throw error;
    } finally {
      for (const { handle } of previous.values()) void handle.dispose().catch(() => {});
    }
    if (changed) {
      this.revision += 1;
      const bindings = new Map<string, NodeBinding>();
      const states = new Map<string, StoredElement>();
      for (const [index, element] of elements.entries()) {
        const oldRef = element.ref ?? '';
        const newRef = `e${this.revision}_${index}`;
        const binding = this.bindings.get(oldRef);
        const state = this.refStore.get(oldRef);
        if (binding) bindings.set(newRef, binding);
        if (state) states.set(newRef, state);
        element.ref = newRef;
      }
      this.bindings = bindings;
      this.refStore = states;
    }

    const overlays =
      request.include?.includes('overlays') === true
        ? await this.collectOverlays(elements)
        : undefined;

    return {
      revision: this.revision,
      url: this.page.url(),
      title: await this.page.title(),
      status: 'interactive',
      content: await this.page.content(),
      elements: elements,
      ...(overlays !== undefined ? { overlays } : {}),
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
      const elementMatch =
        /^([a-zA-Z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+\[[^\]]*\])*(?::\s*(.*))?$/.exec(text);
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

  /** Client-facing context for a refusal: which ref, in which revision, what it was. */
  private refusalDetails(ref: string, stored?: { role: string; name?: string }) {
    return {
      ref,
      revision: this.revision,
      ...(stored
        ? { role: stored.role, ...(stored.name !== undefined ? { name: stored.name } : {}) }
        : {}),
    };
  }

  async resolve(target: EngineTarget): Promise<ResolvedTarget> {
    const stored = this.refStore.get(target.ref);
    const binding = this.bindings.get(target.ref);
    if (!stored) {
      throw new EngineError(
        'TARGET_NOT_FOUND',
        `Element not found: ${target.ref} (observe the page to mint refs)`,
        false,
        // An unknown ref carries no contradicting live evidence - the engine
        // simply lost track of it - so a remap heal may consume this refusal.
        { ...this.refusalDetails(target.ref), remapEligible: true }
      );
    }
    if (!binding) {
      // DOM-only fallback can discover a control without enough semantics to
      // bind it. The ref was observed, but is not safe to act on yet.
      throw new EngineError(
        'STALE_TARGET',
        'Observed target could not be bound safely; observe again.',
        true,
        {
          ...this.refusalDetails(target.ref, stored),
          remapEligible: true,
        }
      );
    }
    if (!(await binding.handle.evaluate((node) => node.isConnected))) {
      throw new EngineError(
        'STALE_TARGET',
        'Observed node was detached or replaced; observe again.',
        false,
        {
          ...this.refusalDetails(target.ref, stored),
          remapEligible: true,
        }
      );
    }
    const visible = await binding.handle.isVisible();
    const enabled = await binding.handle.isEnabled();
    if (visible && enabled) {
      // Some CDP adapters materialize fresh JavaScript wrappers for the same
      // DOM node. Compare DOM identity, not wrapper-object equality.
      const current =
        (await binding.locator.count()) === 1
          ? await binding.locator.elementHandle({ timeout: 1000 })
          : null;
      let matchesOriginal = false;
      try {
        matchesOriginal =
          current !== null &&
          (await binding.handle.evaluate(
            (original, candidate) => original.isSameNode(candidate),
            current
          ));
      } finally {
        await current?.dispose();
      }
      if (!matchesOriginal) {
        throw new EngineError(
          'STALE_TARGET',
          'Observed target identity or semantic state changed; observe again.',
          false,
          {
            ...this.refusalDetails(target.ref, stored),
            remapEligible: true,
          }
        );
      }
      const expectedSnapshot = binding.snapshot ?? binding.documentSnapshot;
      if (expectedSnapshot === undefined) {
        throw new EngineError(
          'STALE_TARGET',
          'Semantic evidence is unavailable; observe again.',
          true,
          this.refusalDetails(target.ref, stored)
        );
      }
      // Evidence provenance is fixed at observation. A failed fresh element check
      // cannot switch to document evidence or substitute the old value.
      const semanticLocator =
        binding.snapshot !== undefined ? binding.locator : this.page.locator('body');
      const liveSnapshot = snapshotDigest(
        await semanticLocator.ariaSnapshot({
          timeout: this.engine.snapshotTimeoutMs,
        })
      );
      if (liveSnapshot !== expectedSnapshot) {
        throw new EngineError(
          'STALE_TARGET',
          'Observed semantic state changed; observe again.',
          true,
          this.refusalDetails(target.ref, stored)
        );
      }
    }

    return {
      ref: target.ref,
      fingerprint: canonicalFingerprint({ ...stored, visible, enabled }),
      role: stored.role,
      ...(stored.name !== undefined ? { name: stored.name } : {}),
      visible,
      enabled,
    };
  }

  /** Locator for a stored element, addressed semantically (never selectors). */
  private locatorFor(ref: string) {
    const binding = this.bindings.get(ref);
    if (!binding) {
      throw new EngineError(
        'TARGET_NOT_FOUND',
        `Element not found: ${ref} (observe the page to mint refs)`,
        false,
        this.refusalDetails(ref, this.refStore.get(ref))
      );
    }
    return binding.handle;
  }

  async act(action: EngineAction): Promise<ActionEffect> {
    try {
      return await this.performAction(action);
    } catch (error) {
      const failure = normalizeEngineError(error);
      let details = failure.details;
      // F2: opt-in healing. resolve() fails BEFORE any locator action runs,
      // so the remap retry cannot double-fire on the dead control. Live
      // semantic-evidence mismatches never carry remapEligible and are
      // therefore never healed.
      if (
        action.remap === true &&
        action.target !== undefined &&
        failure.code === 'STALE_TARGET' &&
        details?.remapEligible === true
      ) {
        let remap: Awaited<ReturnType<PlaywrightPage['tryRemap']>>;
        try {
          remap = await this.tryRemap(action);
        } catch {
          throw new EngineError(failure.code, failure.message, failure.retryable, details);
        }
        if ('action' in remap) {
          try {
            const effect = await this.performAction(remap.action);
            return { ...effect, remap: { from: action.target.ref, to: remap.to } };
          } catch (retryError) {
            const retryFailure = normalizeEngineError(retryError);
            throw new EngineError(
              retryFailure.code,
              retryFailure.message,
              retryFailure.retryable,
              retryFailure.details
            );
          }
        }
        throw new EngineError(failure.code, failure.message, failure.retryable, {
          ...details,
          candidates: remap.candidates,
        });
      }
      if (failure.code === 'ACTION_TIMEOUT' && action.target && details?.blockedBy === undefined) {
        // A blocked main thread is a common CAUSE of the timeout we are
        // describing; bound the diagnostic so it cannot outlive the error.
        const blockedBy = await withDeadline(this.describeBlocker(action.target.ref), 2_000).catch(
          () => undefined
        );
        details = {
          ...details,
          ref: action.target.ref,
          ...(blockedBy ? { blockedBy } : {}),
        };
      }
      throw new EngineError(failure.code, failure.message, failure.retryable, details);
    }
  }

  /**
   * Re-observe and match the refused element by role+name. Exactly one
   * match heals; zero or several candidates refuse with the count rather
   * than guess. Returns the rebuilt action targeting the fresh ref.
   */
  private async tryRemap(
    action: EngineAction
  ): Promise<{ action: EngineAction; to: string } | { candidates: number }> {
    const target = action.target;
    if (target === undefined) {
      return { candidates: 0 };
    }
    const stored = this.refStore.get(target.ref);
    if (stored === undefined) {
      return { candidates: 0 };
    }
    const fresh = await this.observe({});
    const candidates = fresh.elements.filter(
      (e) => e.role === stored.role && (stored.name === undefined || e.name === stored.name)
    );
    const match = candidates.length === 1 ? candidates[0] : undefined;
    if (match?.ref === undefined || match.ref === target.ref) {
      return { candidates: candidates.length };
    }
    return { action: { ...action, target: { ref: match.ref } }, to: match.ref };
  }

  /**
   * Name whatever covers a timed-out target's click point. Purely diagnostic:
   * every failure path throws, which the caller turns into "no blocker
   * reported" so diagnostics can never mask or alter the underlying timeout.
   */
  private async describeBlocker(
    ref: string
  ): Promise<{ tag: string; role?: string; name?: string }> {
    const binding = this.bindings.get(ref);
    if (!binding) {
      throw new Error(`no binding for ${ref}`);
    }
    return binding.handle.evaluate((node) => {
      const doc = node.ownerDocument;
      const win = doc.defaultView;
      if (!win) {
        throw new Error('no view');
      }
      const box = node.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) {
        throw new Error('no box');
      }
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      if (cx < 0 || cy < 0 || cx > win.innerWidth || cy > win.innerHeight) {
        throw new Error('off viewport');
      }
      for (const element of doc.elementsFromPoint(cx, cy)) {
        if (element === node || node.contains(element) || element.contains(node)) continue;
        const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim();
        const role = element.getAttribute('role');
        return {
          tag: element.tagName.toLowerCase(),
          ...(role ? { role } : {}),
          ...(name ? { name: name.slice(0, 100) } : {}),
        };
      }
      throw new Error('unoccluded');
    });
  }

  /**
   * Opt-in occlusion census (F5): probe up to 30 visible observed elements
   * and aggregate whatever covers their click points. Purely diagnostic:
   * probe failures skip the element and never fail the observation.
   */
  private async collectOverlays(elements: StoredElement[]): Promise<OverlayBlocker[]> {
    const EXAMINE_CAP = 30;
    const blockers = new Map<string, OverlayBlocker>();
    let examined = 0;
    for (const element of elements) {
      if (examined >= EXAMINE_CAP) {
        break;
      }
      if (!element.visible) {
        continue;
      }
      const binding = this.bindings.get(element.ref ?? '');
      if (!binding) {
        continue;
      }
      examined += 1;
      const blocker = await binding.locator
        .evaluate((node) => {
          const doc = node.ownerDocument;
          const win = doc.defaultView;
          if (!win) {
            return undefined;
          }
          const box = node.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) {
            return undefined;
          }
          const cx = box.left + box.width / 2;
          const cy = box.top + box.height / 2;
          if (cx < 0 || cy < 0 || cx > win.innerWidth || cy > win.innerHeight) {
            return undefined;
          }
          for (const candidate of doc.elementsFromPoint(cx, cy)) {
            if (candidate === node || node.contains(candidate) || candidate.contains(node)) {
              continue;
            }
            const name = (
              candidate.getAttribute('aria-label') ??
              candidate.textContent ??
              ''
            ).trim();
            const role = candidate.getAttribute('role');
            return {
              tag: candidate.tagName.toLowerCase(),
              ...(role ? { role } : {}),
              ...(name ? { name: name.slice(0, 100) } : {}),
            };
          }
          return undefined;
        })
        .catch(() => undefined);
      if (blocker === undefined) {
        continue;
      }
      const key = JSON.stringify([blocker.tag, blocker.role ?? '', blocker.name ?? '']);
      const existing = blockers.get(key);
      if (existing) {
        existing.covers += 1;
      } else {
        blockers.set(key, { ...blocker, covers: 1 });
      }
    }
    return [...blockers.values()];
  }

  private async performAction(action: EngineAction): Promise<ActionEffect> {
    // Upload skips the visibility gate: file inputs are hidden by design and
    // a targeted upload addresses an observed ref whose handle was bound
    // regardless of visibility.
    if (action.target && action.type !== 'upload') {
      const live = await this.resolve(action.target);
      if (!live.visible) throw new EngineError('TARGET_NOT_VISIBLE', 'Target is not visible');
      if (!live.enabled) throw new EngineError('TARGET_DISABLED', 'Target is disabled');
    }
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
      case 'upload': {
        // Local path validation happens before any page contact: a missing
        // file is a caller mistake, not page state, and must leave the page
        // (and the revision) untouched.
        const paths = (action.paths as string[] | undefined) ?? [];
        if (paths.length === 0) {
          throw new EngineError('INVALID_REQUEST', 'upload requires at least one path');
        }
        const { stat } = await import('node:fs/promises');
        const { basename } = await import('node:path');
        const files: Array<{ name: string; size: number }> = [];
        for (const p of paths) {
          try {
            const s = await stat(p);
            files.push({ name: basename(p), size: s.size });
          } catch {
            throw new EngineError('INVALID_REQUEST', `File not found: ${p}`);
          }
        }
        // Browser-verified evidence, read BEFORE bumpRevision - releaseRefs
        // disposes the handles the ref path binds. Structural casts: this
        // package compiles without DOM lib, so the input's file-list shape
        // is described locally.
        let inputFiles: string[] | null = null;
        if (action.target) {
          const handle = this.locatorFor((action.target as EngineTarget).ref);
          await handle.setInputFiles(paths);
          inputFiles = await handle
            .evaluate((el) => {
              const input = el as unknown as {
                type?: unknown;
                files?: ArrayLike<{ name: unknown }> | null;
              };
              return String(input.type) === 'file' && input.files
                ? Array.from(input.files, (f) => String(f.name))
                : null;
            })
            .catch(() => null);
          this.bumpRevision();
        } else {
          // Un-targeted mode: hidden inputs get no ref from observe, so the
          // single-file-input page is the common case; ambiguity is refused
          // rather than guessed.
          const locator = this.page.locator('input[type=file]');
          const count = await locator.count();
          if (count === 0) {
            throw new EngineError('TARGET_NOT_FOUND', 'No file input found on the page');
          }
          if (count > 1) {
            throw new EngineError(
              'TARGET_AMBIGUOUS',
              `Page has ${count} file inputs; observe and target one by ref`,
              false,
              { count }
            );
          }
          await locator.setInputFiles(paths);
          inputFiles = await locator
            .evaluate((el) => {
              const input = el as unknown as {
                type?: unknown;
                files?: ArrayLike<{ name: unknown }> | null;
              };
              return String(input.type) === 'file' && input.files
                ? Array.from(input.files, (f) => String(f.name))
                : null;
            })
            .catch(() => null);
          this.bumpRevision();
        }
        return {
          actionId,
          startTimestamp,
          endTimestamp: new Date().toISOString(),
          oldRevision,
          newRevision: this.revision,
          result: {
            success: true,
            files,
            ...(inputFiles ? { inputFiles } : {}),
          },
        };
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
        const amount = Number(action.amount ?? 500);
        const deltaX = Number(
          action.deltaX ??
            (action.direction === 'left' ? -amount : action.direction === 'right' ? amount : 0)
        );
        const deltaY = Number(
          action.deltaY ??
            (action.direction === 'up' ? -amount : action.direction === 'down' ? amount : 0)
        );
        if (action.target) {
          await this.locatorFor(action.target.ref).evaluate(
            (element, delta) => element.scrollBy(delta.x, delta.y),
            { x: deltaX, y: deltaY }
          );
        } else {
          await this.page.mouse.wheel(deltaX, deltaY);
        }
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
        // urlPattern/selectorVisible/minElements are service-evaluated (the
        // service polls engine state to its own deadline). Waiting for
        // 'load' here would double-wait and can fail the act before the
        // real poll ever runs.
        const serviceEvaluated =
          condition?.until === 'urlPattern' ||
          condition?.until === 'selectorVisible' ||
          condition?.until === 'minElements';
        if (!serviceEvaluated) {
          const state = condition?.until === 'networkidle' ? 'networkidle' : 'load';
          // Playwright reads an explicit 0 as "wait forever" - clamp.
          const timeout =
            condition?.timeoutMs !== undefined ? Math.max(1, condition.timeoutMs) : undefined;
          await this.waitForLoadState(state, { timeout });
        }
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
  notifyDownloadCreated(filename: string, downloadId: string): void {
    this.enqueueEvent({
      type: 'download.created',
      timestamp: new Date().toISOString(),
      sessionId: 'unknown',
      pageId: this.id,
      data: { filename, downloadId },
    });
  }

  notifyDownloadFinished(filename: string, downloadId: string): void {
    this.enqueueEvent({
      type: 'download.finished',
      timestamp: new Date().toISOString(),
      sessionId: 'unknown',
      pageId: this.id,
      data: { filename, downloadId },
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

  /**
   * Wait until a CSS selector is visible (the `selectorVisible` wait
   * primitive). Real locator visibility, not a sleep; the service maps
   * missed deadlines to ACTION_TIMEOUT.
   */
  async waitForSelector(selector: string, options: { timeoutMs?: number } = {}): Promise<void> {
    // Playwright reads an explicit 0 as "wait forever" - clamp to a floor.
    const timeoutMs = Math.max(1, options.timeoutMs ?? 5000);
    try {
      await this.page.locator(selector).waitFor({
        state: 'visible',
        timeout: timeoutMs,
      });
    } catch (error) {
      const failure = normalizeEngineError(error);
      throw new EngineError(
        'ACTION_TIMEOUT',
        `Selector '${selector}' did not become visible within ${timeoutMs}ms.`,
        true,
        { selector, timeoutMs, ...failure.details }
      );
    }
  }

  async close(): Promise<void> {
    this.eventsClosed = true;
    this.releaseRefs();
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
    this.page.off('crash', this.onPageCrashed);
    await this.page.close();
  }
}
