/**
 * AgentBrowserService - the composition root
 *
 * Wires the real stack together: SessionCoordinator for lifecycle, an
 * injected BrowserEngine, ObservationNormalizer for semantic observations,
 * ActionExecutor for ref-based actions, NetworkPolicy for navigation egress
 * (SSRF defense on by default), and the ApprovalGate for high-risk elements.
 *
 * The service is the revision authority: it stamps normalized refs and
 * validates staleness in its own revision space, and projects engine action
 * effects into that space. Element refs are scoped to session + page and are
 * only accepted as refs - never selectors.
 */

import {
  ActionExecutor,
  ApprovalGate,
  ArtifactStore,
  ObservationNormalizer,
  SecretManager,
  SessionCoordinator,
  SessionState,
} from '@agentbrowser/core';
import type { ArtifactMetadata } from '@agentbrowser/core';
import type { InMemoryTracer, Span } from '@agentbrowser/core';
import type { MetricsRegistry } from '@agentbrowser/core';
import type { StructuredLogger } from '@agentbrowser/core';
import type { BrowserEngine, EngineEvent, EnginePage } from '@agentbrowser/engine';
import type { EngineSession, EngineSessionOptions, NormalizedCookie } from '@agentbrowser/engine';
import type { RawPageState } from '@agentbrowser/engine';
import type { RequestPolicy } from '@agentbrowser/engine';
import { SchemaExtractor } from '@agentbrowser/extraction';
import {
  extractForms,
  extractJsonLd,
  extractLinks,
  extractMarkdown,
  extractTables,
  extractVisibleText,
} from '@agentbrowser/extraction';
import { NetworkPolicy, SessionHostPolicy } from '@agentbrowser/policy';
import type {
  ArtifactRef,
  ObservationRequest,
  PageElement,
  PageState,
  PdfRequest,
  ScreenshotRequest,
} from '@agentbrowser/protocol';

/** Typed failure carrying a protocol error code. */
export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface ServiceSessionRequest {
  tenantId?: string;
  engine?: string;
  ttlMs?: number;
  idleTimeoutMs?: number;
  viewport?: { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  headless?: boolean;
  /**
   * Seed cookies for the session's context, to reuse an already-authenticated
   * session (e.g. bypass an SSO / device-trust login the browser can't pass).
   */
  cookies?: NormalizedCookie[];
  /** Downloads are denied unless the session explicitly allows them. */
  allowDownloads?: boolean;
  maxDownloadBytes?: number;
  /** Per-session host rules, chained over the SSRF base (restrict-only). */
  allowedHosts?: string[];
  blockedHosts?: string[];
}

export interface ServiceSessionView {
  sessionId: string;
  status: string;
  engine: { name: string; version: string };
  createdAt: string;
  ttlMs: number;
  idleTimeoutMs: number;
  /** Owning tenant, when the session was created under one. */
  tenantId?: string;
}

export interface ServicePageView {
  pageId: string;
  sessionId: string;
  status: string;
  url?: string;
  title?: string;
}

export interface ServiceActRequest {
  action: string;
  target?: { ref: string } | undefined;
  value?: string | undefined;
  key?: string | undefined;
  direction?: 'up' | 'down' | 'left' | 'right' | undefined;
  amount?: number | undefined;
  observe?: 'after' | 'none' | undefined;
  expectedRevision?: number | undefined;
  approvalToken?: string | undefined;
  /** Prompt answer for acceptDialog. */
  promptText?: string | undefined;
  /** Post-action wait condition (spec 11.1). */
  wait?: { until: string; timeoutMs?: number | undefined } | undefined;
}

export interface ServiceActResult {
  status: 'success';
  actionId: string;
  newRevision: number;
  observation?: PageState | undefined;
  /** Why the post-action wait completed (spec 11.1). */
  waitReason?: string | undefined;
}

export interface ServiceDependencies {
  engine: BrowserEngine;
  /**
   * TD-BROWSER-7 Phase 1: named auxiliary engines. createSession routes by
   * the request's `engine` field; unknown names fail loudly.
   */
  engines?: Record<string, BrowserEngine>;
  coordinator?: SessionCoordinator;
  normalizer?: ObservationNormalizer;
  executor?: ActionExecutor;
  networkPolicy?: NetworkPolicy;
  approvalGate?: ApprovalGate;
  /** Secret registry; values are redacted from every service output. */
  secretManager?: SecretManager;
  /** Artifact retention store; defaults to a bounded in-memory store. */
  artifactStore?: ArtifactStore;
  /** Payload fetcher for downloads; injectable for tests. */
  downloader?(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Operation tracer; absent means tracing is disabled. */
  tracer?: InMemoryTracer;
  /** Operation metrics; absent means metrics are disabled. */
  metrics?: MetricsRegistry;
  /** Structured operation log; absent means no operation logging. */
  logger?: StructuredLogger;
  /** How often to reconcile service state with coordinator expiry (ms). */
  sweepIntervalMs?: number;
}

/** Risk classes that require an approval token before the action runs. */
const HIGH_RISK_EFFECTS = new Set([
  'transaction',
  'account-security',
  'external-message',
  'destructive',
]);

const REF_PATTERN = /^e(\d+)_(\d+)$/;

interface PageContext {
  sessionId: string;
  enginePage: EnginePage;
  revision: number;
  /** The last observation handed to a client, in service revision space. */
  lastObservation?:
    | {
        revision: number;
        /** normalized ref -> engine ref */
        refMap: Map<string, string>;
        byRef: Map<string, PageElement>;
      }
    | undefined;
  /** Recent observations by revision, for sinceRevision diffs. */
  history: Map<number, ObservationSnapshot>;
}

/** A snapshot of one observation, keyed both ways for diffing. */
interface ObservationSnapshot {
  byRef: Map<string, PageElement>;
  byEngineRef: Map<string, PageElement>;
}

/** How many recent revisions per page are diffable. */
const HISTORY_LIMIT = 8;

/** Observation options as they arrive from a route body (possibly undefined). */
export type PartialObservation = {
  mode?: ObservationRequest['mode'] | undefined;
  maxElements?: number | undefined;
  maxBytes?: number | undefined;
  sinceRevision?: number | undefined;
  continueFrom?: number | undefined;
};

export class AgentBrowserService {
  private readonly engine: BrowserEngine;
  private readonly engines: Map<string, BrowserEngine> = new Map();
  private readonly coordinator: SessionCoordinator;
  private readonly normalizer: ObservationNormalizer;
  private readonly executor: ActionExecutor;
  private readonly networkPolicy: NetworkPolicy;
  private readonly rootRequestPolicy: RequestPolicy;
  private readonly approvalGate: ApprovalGate;
  private readonly secretManager: SecretManager;
  private readonly artifacts: ArtifactStore;
  private readonly downloader: NonNullable<ServiceDependencies['downloader']>;
  private readonly tracer?: InMemoryTracer;
  private readonly metrics?: MetricsRegistry;
  private readonly logger?: StructuredLogger;
  /** Per-session download policy, captured at creation (denying by default). */
  private readonly sessionDownloadPolicy = new Map<
    string,
    { allowDownloads: boolean; maxDownloadBytes: number }
  >();
  /** Per-session egress chain (fast-fail + engine choke point, one verdict). */
  private readonly sessionPolicies = new Map<string, RequestPolicy>();
  private readonly pages = new Map<string, PageContext>();
  private pageCounter = 0;
  /** Audit log of sessions terminated by engine crashes (TD-024). */
  private readonly crashLog: Array<{ sessionId: string; reason: string; timestamp: string }> = [];
  /** Session -> event listeners, fed by per-page engine event pumps. */
  private readonly eventListeners = new Map<string, Set<(event: EngineEvent) => void>>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: ServiceDependencies) {
    this.engine = deps.engine;
    for (const [name, engine] of Object.entries(deps.engines ?? {})) {
      this.engines.set(name, engine);
    }
    this.coordinator =
      deps.coordinator ?? new SessionCoordinator({ cleanupCheckIntervalMs: 3_600_000 });
    this.normalizer = deps.normalizer ?? new ObservationNormalizer();
    this.executor = deps.executor ?? new ActionExecutor(this.normalizer);
    // SSRF defenses are on by default (ADR-006): loopback, private ranges and
    // cloud metadata endpoints are blocked unless a policy is injected.
    this.networkPolicy =
      deps.networkPolicy ??
      new NetworkPolicy({ blockLoopback: true, blockPrivateIPs: true, blockMetadata: true });
    // The root policy is both the service fast-fail and the engine choke
    // point's base: one verdict, enforced at both layers.
    this.rootRequestPolicy = this.networkPolicy;
    this.approvalGate = deps.approvalGate ?? new ApprovalGate({ cleanupIntervalMs: 3_600_000 });
    // An empty registry redacts nothing; a populated one is enforced at every
    // output boundary (observations, error messages, error details).
    this.secretManager = deps.secretManager ?? new SecretManager();
    this.artifacts = deps.artifactStore ?? new ArtifactStore();
    this.downloader = deps.downloader ?? defaultDownloader;
    // Telemetry is opt-in per concern: each is wired only when provided.
    if (deps.tracer !== undefined) {
      this.tracer = deps.tracer;
    }
    if (deps.metrics !== undefined) {
      this.metrics = deps.metrics;
    }
    if (deps.logger !== undefined) {
      this.logger = deps.logger;
    }
    // Reconcile with coordinator expiry so TTL/idle lapses release service
    // state (page registry, listeners, policies) instead of leaking it.
    const sweepIntervalMs = deps.sweepIntervalMs ?? 30_000;
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweepExpiredSessions(), sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  /** Drop service state for sessions the coordinator no longer tracks. */
  private sweepExpiredSessions(): void {
    const tracked = new Set<string>([
      ...this.sessionDownloadPolicy.keys(),
      ...this.eventListeners.keys(),
      ...[...this.pages.values()].map((page) => page.sessionId),
    ]);
    for (const sessionId of tracked) {
      // coordinator.get() lazily expires TTL/idle-lapsed sessions.
      if (this.coordinator.get(sessionId) === undefined) {
        // Notify subscribers once: the session expired (spec: expiry events
        // on the stream), then drop the listeners with the session.
        const listeners = this.eventListeners.get(sessionId);
        if (listeners !== undefined) {
          const expiredEvent: EngineEvent = {
            type: 'page.destroyed',
            timestamp: new Date().toISOString(),
            sessionId,
            data: { reason: 'session-expired' },
          };
          for (const listener of [...listeners]) {
            try {
              listener(expiredEvent);
            } catch {
              // A misbehaving listener never blocks the sweep.
            }
          }
        }
        for (const [pageId, page] of this.pages) {
          if (page.sessionId === sessionId) {
            this.pages.delete(pageId);
          }
        }
        this.eventListeners.delete(sessionId);
        this.sessionDownloadPolicy.delete(sessionId);
        this.sessionPolicies.delete(sessionId);
      }
    }
  }

  /**
   * Run an operation under a span: success ends it with outcome ok, failure
   * marks it error with the protocol code. Children link to the span.
   */
  private traced<T>(
    name: string,
    attributes: Record<string, unknown>,
    operation: (span: Span | undefined) => Promise<T>
  ): Promise<T> {
    const span = this.tracer?.startSpan(name, attributes);
    const startedAt = Date.now();
    return operation(span).then(
      (value) => {
        this.telemetry(name, 'ok', attributes, startedAt, undefined);
        if (span) {
          this.tracer?.endSpan(span, { outcome: 'ok' });
        }
        return value;
      },
      (error) => {
        const code = error instanceof ServiceError ? error.code : 'INTERNAL';
        this.telemetry(name, 'error', attributes, startedAt, code);
        if (span) {
          this.tracer?.failSpan(span, code, error instanceof Error ? error.message : String(error));
          this.tracer?.endSpan(span);
        }
        throw error;
      }
    );
  }

  /** Record metrics and a structured log line for one completed operation. */
  private telemetry(
    operation: string,
    outcome: 'ok' | 'error',
    attributes: Record<string, unknown>,
    startedAt: number,
    code: string | undefined
  ): void {
    if (this.metrics) {
      this.metrics.incrementCounter('operations_total', { operation, outcome });
      this.metrics.observe('operation_duration_ms', Date.now() - startedAt, { operation });
      if (code !== undefined) {
        this.metrics.incrementCounter('errors_total', { code });
      }
    }
    if (this.logger) {
      const fields: Record<string, unknown> = { ...attributes, outcome };
      if (code !== undefined) {
        fields.code = code;
      }
      if (outcome === 'error') {
        this.logger.warn(operation, fields);
      } else {
        this.logger.info(operation, fields);
      }
    }
  }

  /**
   * Subscribe to a session's engine events (page loads, console output,
   * crashes). Returns an unsubscribe function, or undefined when the session
   * does not exist. Events are stamped with the service's session and page
   * ids before delivery.
   */
  subscribe(sessionId: string, listener: (event: EngineEvent) => void): (() => void) | undefined {
    if (!this.coordinator.get(sessionId)) {
      return undefined;
    }
    const listeners = this.eventListeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  /** Pull a page's engine events forever, dispatching to session listeners. */
  private pumpEvents(sessionId: string, pageId: string, enginePage: EnginePage): void {
    void (async () => {
      try {
        for await (const event of enginePage.events()) {
          const stamped: EngineEvent = { ...event, sessionId, pageId };
          const listeners = this.eventListeners.get(sessionId);
          if (listeners) {
            for (const listener of [...listeners]) {
              try {
                listener(stamped);
              } catch {
                // A misbehaving listener never breaks the stream.
              }
            }
          }
        }
      } catch {
        // The engine page went away; the pump simply ends.
      }
    })();
  }

  /** Error messages that indicate the engine itself died. */
  private static readonly CRASH_PATTERN =
    /crash|browser (has been )?closed|browser.*disconnect|target (page|context).*closed|context.*closed/i;

  private isCrash(message: string): boolean {
    return AgentBrowserService.CRASH_PATTERN.test(message);
  }

  /**
   * Terminate a session after an engine crash: drop its pages, remove it
   * from tracking, close the engine session best-effort, and record the
   * event for the cleanup audit.
   */
  private async recoverFromCrash(sessionId: string, reason: string): Promise<void> {
    for (const [pageId, page] of this.pages) {
      if (page.sessionId === sessionId) {
        this.pages.delete(pageId);
      }
    }
    this.sessionDownloadPolicy.delete(sessionId);
    this.sessionPolicies.delete(sessionId);
    await this.coordinator.terminate(sessionId, SessionState.ENGINE_CRASHED, reason).catch(() => {
      // The session may already be gone; the audit entry stands.
    });
    this.metrics?.incrementCounter('sessions_crashed_total');
    this.logger?.error('session.crashed', { sessionId, reason });
    this.crashLog.push({ sessionId, reason, timestamp: new Date().toISOString() });
  }

  /** Crash audit: which sessions died, why, and when. */
  getCrashLog(): ReadonlyArray<{ sessionId: string; reason: string; timestamp: string }> {
    return this.crashLog;
  }

  // ---- tenant validation (lightweight security) -------------------------

  /**
   * Validate tenant ID format (lightweight security check).
   *
   * This is format validation only - it rejects obviously invalid or malicious
   * tenant IDs but does not verify authorization. Full tenant authorization is
   * tracked as TD-BROWSER-4.
   *
   * Rules:
   * - Must be non-empty if provided
   * - Must be 1-64 characters
   * - Must contain only alphanumeric characters, hyphens, and underscores
   * - Must not start or end with hyphen/underscore
   *
   * Examples of valid tenant IDs:
   * - "default"
   * - "tenant-123"
   * - "my_organization"
   * - "acme-corp_2024"
   *
   * Examples of invalid tenant IDs (rejected):
   * - "" (empty)
   * - "   " (whitespace)
   * - "../etc/passwd" (path traversal attempt)
   * - "<script>alert(1)</script>" (XSS attempt)
   * - "a".repeat(100) (too long)
   */
  private validateTenantId(tenantId: string | undefined): void {
    if (!tenantId) {
      // Empty tenant ID is allowed for backward compatibility (defaults to "default")
      return;
    }

    // Length check
    if (tenantId.length < 1 || tenantId.length > 64) {
      throw new ServiceError(
        'INVALID_TENANT_ID',
        `Tenant ID must be 1-64 characters, got ${tenantId.length}`
      );
    }

    // Format check: alphanumeric, hyphen, underscore only
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/.test(tenantId)) {
      throw new ServiceError(
        'INVALID_TENANT_ID',
        'Tenant ID must contain only alphanumeric characters, hyphens, and underscores, and must not start or end with hyphen/underscore'
      );
    }
  }

  // ---- sessions -----------------------------------------------------------

  async createSession(request: ServiceSessionRequest): Promise<ServiceSessionView> {
    // Validate tenant ID format (lightweight security)
    this.validateTenantId(request.tenantId);

    return this.traced('session.create', { tenantId: request.tenantId ?? '' }, async () => {
      const engineRequest: EngineSessionOptions & { engine: 'auto' } = { engine: 'auto' };
      const engine = this.resolveEngine(request.engine);
      if (request.viewport !== undefined) engineRequest.viewport = request.viewport;
      if (request.locale !== undefined) engineRequest.locale = request.locale;
      if (request.timezoneId !== undefined) engineRequest.timezoneId = request.timezoneId;
      if (request.headless !== undefined) engineRequest.headless = request.headless;
      if (request.cookies !== undefined) engineRequest.cookies = request.cookies;

      // Per-session chain: session rules restrict; the SSRF base always runs.
      const sessionPolicy =
        request.allowedHosts !== undefined || request.blockedHosts !== undefined
          ? new SessionHostPolicy(this.networkPolicy, {
              ...(request.allowedHosts !== undefined ? { allowedHosts: request.allowedHosts } : {}),
              ...(request.blockedHosts !== undefined ? { blockedHosts: request.blockedHosts } : {}),
            })
          : this.rootRequestPolicy;

      let session: import('@agentbrowser/protocol').SessionResponse;
      try {
        session = await this.coordinator.create(
          {
            ...engineRequest,
            ...(request.tenantId !== undefined ? { tenantId: request.tenantId } : {}),
            ...(request.ttlMs !== undefined ? { ttlMs: request.ttlMs } : {}),
            ...(request.idleTimeoutMs !== undefined
              ? { idleTimeoutMs: request.idleTimeoutMs }
              : {}),
            requestPolicy: sessionPolicy,
          },
          engine
        );
      } catch (error) {
        throw this.mapError(error);
      }

      this.metrics?.incrementCounter('sessions_created_total');
      this.metrics?.setGauge('sessions_active', this.coordinator.getSessionCount());

      this.sessionDownloadPolicy.set(session.sessionId, {
        allowDownloads: request.allowDownloads === true,
        maxDownloadBytes: request.maxDownloadBytes ?? 10 * 1024 * 1024,
      });
      this.sessionPolicies.set(session.sessionId, sessionPolicy);

      return {
        sessionId: session.sessionId,
        status: 'ready',
        engine: { name: session.engine.name, version: session.engine.version },
        createdAt: session.createdAt,
        ttlMs: session.ttlMs,
        idleTimeoutMs: session.idleTimeoutMs,
        ...(request.tenantId !== undefined ? { tenantId: request.tenantId } : {}),
      };
    });
  }

  getSession(sessionId: string): ServiceSessionView | undefined {
    const context = this.coordinator.get(sessionId);
    if (!context) {
      return undefined;
    }
    return {
      sessionId: context.id,
      status: context.state.toLowerCase(),
      engine: { name: context.metadata.engineName, version: this.engine.version },
      createdAt: new Date(context.metadata.createdAt).toISOString(),
      ttlMs: context.metadata.ttlMs,
      idleTimeoutMs: context.metadata.idleTimeoutMs,
      ...(context.metadata.tenantId !== undefined ? { tenantId: context.metadata.tenantId } : {}),
    };
  }

  listSessions(): ServiceSessionView[] {
    return this.coordinator.getAllSessions().map((metadata) => ({
      sessionId: metadata.id,
      status: metadata.state.toLowerCase(),
      engine: { name: metadata.engineName, version: this.engine.version },
      createdAt: new Date(metadata.createdAt).toISOString(),
      ttlMs: metadata.ttlMs,
      idleTimeoutMs: metadata.idleTimeoutMs,
    }));
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.coordinator.close(sessionId);
    } catch (error) {
      throw this.mapError(error);
    }
    for (const [pageId, page] of this.pages) {
      if (page.sessionId === sessionId) {
        this.pages.delete(pageId);
      }
    }
    this.sessionDownloadPolicy.delete(sessionId);
    this.sessionPolicies.delete(sessionId);
    this.eventListeners.delete(sessionId);
    this.metrics?.incrementCounter('sessions_closed_total');
    this.metrics?.setGauge('sessions_active', this.coordinator.getSessionCount());
  }

  /** TD-BROWSER-6: scoped cookie export (ADR-005) for the credential handoff loop. */
  async getSessionCookies(
    sessionId: string
  ): Promise<import('@agentbrowser/engine').NormalizedCookie[]> {
    try {
      return await this.coordinator.cookies(sessionId);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /**
   * TD-BROWSER-7 Phase 1: route sessions by engine name. Default/absent/"auto"
   * resolves to the primary engine; unknown names fail loudly - a session must
   * never silently run on a different engine than the one requested.
   */
  private resolveEngine(name?: string): BrowserEngine {
    if (name === undefined || name === 'auto' || name === this.engine.name) {
      return this.engine;
    }
    const engine = this.engines.get(name);
    if (engine === undefined) {
      const registered = ['auto', this.engine.name, ...this.engines.keys()].join(', ');
      throw new Error(
        `ENGINE_NOT_FOUND: no engine registered as "${name}". Registered: ${registered}`
      );
    }
    return engine;
  }

  /**
   * TD-BROWSER-8: execute a batched action plan in one call. Steps run
   * sequentially; a STALE_TARGET failure self-heals once by re-observing and
   * remapping the ref by ordinal (deterministic on stable forms). The first
   * hard failure aborts the plan with the completed prefix reported.
   */
  async executePlan(
    sessionId: string,
    pageId: string,
    steps: ServiceActRequest[]
  ): Promise<{
    ok: boolean;
    completed: number;
    results: Array<{ step: number; ok: boolean; actionId?: string; error?: string }>;
    mode: 'stable' | 'verified';
    error?: { code: string; message: string };
  }> {
    const results: Array<{ step: number; ok: boolean; actionId?: string; error?: string }> = [];
    const churnKey = `${sessionId}:${pageId}`;
    for (const [index, step] of steps.entries()) {
      try {
        const effect = await this.act(sessionId, pageId, step);
        this.decayChurn(churnKey);
        results.push({ step: index, ok: true, actionId: effect.actionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const ordinal = /(?:^|e\d+)_(\d+)$/.exec(step.target?.ref ?? '')?.[1];
        if (ordinal !== undefined && /STALE_TARGET|revision|fingerprint/i.test(message)) {
          this.bumpChurn(churnKey);
          const observed = await this.observe(sessionId, pageId, { mode: 'interactive' });
          const elements =
            (observed as unknown as { elements?: Array<{ ref: string }> }).elements ?? [];
          console.log(
            'PLAN-REMAP:',
            JSON.stringify({ ordinal, stepRef: step.target?.ref, count: elements.length })
          );
          let remapped: string | undefined;
          for (const e of elements) {
            if (typeof e.ref === 'string' && e.ref.endsWith(`_${ordinal}`)) {
              remapped = e.ref;
              break;
            }
          }
          if (remapped !== undefined) {
            const retry = await this.act(sessionId, pageId, { ...step, target: { ref: remapped } });
            results.push({ step: index, ok: true, actionId: retry.actionId });
            continue;
          }
        }
        results.push({ step: index, ok: false, error: message });
        return {
          ok: false,
          completed: index,
          results,
          mode: this.churnMode(churnKey),
          error: { code: 'PLAN_STEP_FAILED', message },
        };
      }
    }
    return { ok: true, completed: steps.length, results, mode: this.churnMode(churnKey) };
  }

  private churn = new Map<string, number>();
  private bumpChurn(key: string): void {
    this.churn.set(key, (this.churn.get(key) ?? 0) + 1);
  }
  private decayChurn(key: string): void {
    this.churn.set(key, Math.max(0, (this.churn.get(key) ?? 0) - 1));
  }
  private churnMode(key: string): 'stable' | 'verified' {
    return (this.churn.get(key) ?? 0) >= 3 ? 'verified' : 'stable';
  }

  /** TD-BROWSER-8: self-contained snapshot payload for one-shot LLM reasoning. */
  async getSnapshot(
    sessionId: string,
    pageId: string
  ): Promise<{
    url: string;
    title: string;
    revision: number;
    mode: 'stable' | 'verified';
    fields: Array<{ ref: string; role: string; label: string }>;
  }> {
    const state = await this.observe(sessionId, pageId, { mode: 'interactive' });
    const view = state as unknown as {
      url?: string;
      title?: string;
      revision?: number;
      elements?: Array<{ ref: string; role?: string; name?: string }>;
    };
    return {
      url: view.url ?? '',
      title: view.title ?? '',
      revision: view.revision ?? 0,
      mode: this.churnMode(`${sessionId}:${pageId}`),
      fields: (view.elements ?? []).map((e) => ({
        ref: e.ref,
        role: e.role ?? '',
        label: e.name ?? '',
      })),
    };
  }

  // ---- pages --------------------------------------------------------------

  async createPage(sessionId: string): Promise<ServicePageView> {
    const session = this.requireSession(sessionId);
    this.coordinator.updateActivity(sessionId);

    const enginePage = await session.engineSession.newPage();
    const pageId = `pg_${++this.pageCounter}_${enginePage.id}`;
    this.pages.set(pageId, { sessionId, enginePage, revision: 1, history: new Map() });

    // Stream engine events to session subscribers until the page closes.
    this.pumpEvents(sessionId, pageId, enginePage);

    return { pageId, sessionId, status: 'ready' };
  }

  getPage(sessionId: string, pageId: string): ServicePageView | undefined {
    const page = this.pages.get(pageId);
    if (!page || page.sessionId !== sessionId) {
      return undefined;
    }
    return { pageId, sessionId, status: 'active' };
  }

  async closePage(sessionId: string, pageId: string): Promise<void> {
    const page = this.requirePage(sessionId, pageId);
    this.coordinator.updateActivity(sessionId);

    await page.enginePage.close();
    this.pages.delete(pageId);
  }

  // ---- navigation ---------------------------------------------------------

  async navigate(
    sessionId: string,
    pageId: string,
    request: { url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | undefined }
  ): Promise<{ status: string; url: string; redirectChain: string[] }> {
    return this.traced('navigate', { sessionId, pageId }, async (span) => {
      const page = this.requirePage(sessionId, pageId);
      this.coordinator.updateActivity(sessionId);

      const url = request.url;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ServiceError('INVALID_REQUEST', `Invalid URL: ${url.slice(0, 100)}`, false);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ServiceError(
          'POLICY_DENIED',
          `Navigation accepts http(s) URLs only; '${parsed.protocol}' is not permitted.`,
          false,
          { url: redactUrl(url) }
        );
      }

      const hostname = this.hostnameOf(url);
      const policySpan = this.tracer?.startSpan('policy.check', { hostname }, span);
      try {
        await this.networkPolicy.checkRequest({ hostname, url });
        if (policySpan) {
          this.tracer?.endSpan(policySpan, { allowed: true });
        }
      } catch (error) {
        if (policySpan) {
          this.tracer?.failSpan(
            policySpan,
            'POLICY_DENIED',
            error instanceof Error ? error.message : String(error)
          );
          this.tracer?.endSpan(policySpan);
        }
        throw this.mapError(error);
      }

      let result: Awaited<ReturnType<EnginePage['navigate']>>;
      try {
        result = await page.enginePage.navigate({
          url,
          ...(request.waitUntil !== undefined ? { waitUntil: request.waitUntil } : {}),
        });
      } catch (error) {
        if (this.isCrash(error instanceof Error ? error.message : String(error))) {
          await this.recoverFromCrash(sessionId, 'navigate: engine crashed');
          throw new ServiceError(
            'ENGINE_CRASHED',
            'The browser engine crashed; the session has been terminated.',
            false,
            { sessionId }
          );
        }
        throw error;
      }
      page.revision += 1;
      page.lastObservation = undefined;

      return { status: result.status, url: result.url, redirectChain: result.redirectChain };
    });
  }

  // ---- observation --------------------------------------------------------

  async observe(
    sessionId: string,
    pageId: string,
    request: PartialObservation
  ): Promise<PageState> {
    const page = this.requirePage(sessionId, pageId);
    this.coordinator.updateActivity(sessionId);

    // Normalize the FULL element list; pagination and diffing are service
    // concerns so the cursor and changes stay coherent with each other.
    const observationRequest: ObservationRequest = {
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
    };
    let raw: Awaited<ReturnType<EnginePage['observe']>>;
    try {
      raw = await page.enginePage.observe(observationRequest);
    } catch (error) {
      if (this.isCrash(error instanceof Error ? error.message : String(error))) {
        await this.recoverFromCrash(sessionId, 'observe: engine crashed');
        throw new ServiceError(
          'ENGINE_CRASHED',
          'The browser engine crashed; the session has been terminated.',
          false,
          { sessionId }
        );
      }
      throw error;
    }

    const observation = this.normalizer.normalize(raw, {
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
      revision: page.revision,
      sessionId,
      pageId,
    });

    // Bridge normalized refs back to engine refs so actions can resolve them.
    const refMap = new Map<string, string>();
    const byRef = new Map<string, PageElement>();
    const byEngineRef = new Map<string, PageElement>();
    observation.elements.forEach((element, index) => {
      byRef.set(element.ref, element);
      const engineRef = raw.elements[index]?.ref;
      if (engineRef !== undefined) {
        refMap.set(element.ref, engineRef);
        byEngineRef.set(engineRef, element);
      }
    });
    page.lastObservation = { revision: page.revision, refMap, byRef };

    // Retain the snapshot for sinceRevision diffs (bounded history).
    page.history.set(page.revision, { byRef, byEngineRef });
    while (page.history.size > HISTORY_LIMIT) {
      const oldest = page.history.keys().next().value;
      if (oldest !== undefined) {
        page.history.delete(oldest);
      }
    }

    if (request.sinceRevision !== undefined) {
      return this.secretManager.redact(
        this.diffObservation(page, observation, request.sinceRevision)
      );
    }

    return this.secretManager.redact(this.paginateObservation(observation, request));
  }

  /**
   * Diff the current observation against a retained revision. Elements are
   * matched by engine ref, which is stable across non-navigating mutations;
   * navigation therefore surfaces as wholesale remove+add.
   */
  private diffObservation(page: PageContext, current: PageState, sinceRevision: number): PageState {
    if (!Number.isInteger(sinceRevision) || sinceRevision < 1) {
      throw new ServiceError(
        'INVALID_REQUEST',
        `Invalid sinceRevision ${sinceRevision}: expected a positive integer.`
      );
    }

    const previous = page.history.get(sinceRevision);
    if (!previous) {
      throw new ServiceError(
        'INVALID_REQUEST',
        `Unknown sinceRevision ${sinceRevision}: no retained observation at that revision. Observe without sinceRevision to get the full page.`
      );
    }

    const snapshot = page.history.get(current.revision)!;
    const changes: import('@agentbrowser/protocol').ElementChange[] = [];

    // Removed: in previous, not in current.
    for (const [engineRef, element] of previous.byEngineRef) {
      if (!snapshot.byEngineRef.has(engineRef)) {
        changes.push({
          ref: element.ref,
          change: 'removed',
          properties: { element: { old: element, new: null } },
        });
      }
    }

    // Added or modified: in current, keyed against previous.
    for (const [engineRef, element] of snapshot.byEngineRef) {
      const before = previous.byEngineRef.get(engineRef);
      if (before === undefined) {
        changes.push({
          ref: element.ref,
          change: 'added',
          properties: { element: { old: null, new: element } },
        });
        continue;
      }

      const properties: Record<string, { old: unknown; new: unknown }> = {};
      for (const field of ['role', 'name', 'value', 'visible', 'enabled'] as const) {
        const old = before[field];
        const now = element[field];
        if (old !== now) {
          properties[field] = { old: old ?? null, new: now ?? null };
        }
      }
      if (Object.keys(properties).length > 0) {
        changes.push({ ref: element.ref, change: 'modified', properties });
      }
    }

    // Token-efficient: the diff carries only what changed.
    const changedRefs = new Set(changes.map((c) => c.ref));
    return {
      ...current,
      elements: current.elements.filter((el) => changedRefs.has(el.ref)),
      changes,
      truncated: false,
    };
  }

  /**
   * Apply element pagination in stable document order, with a continuation
   * cursor when elements remain.
   */
  private paginateObservation(observation: PageState, request: PartialObservation): PageState {
    const { continueFrom, maxElements } = request;
    if (continueFrom !== undefined && (!Number.isInteger(continueFrom) || continueFrom < 0)) {
      throw new ServiceError(
        'INVALID_REQUEST',
        `Invalid continueFrom ${continueFrom}: expected a non-negative integer.`
      );
    }
    if (maxElements !== undefined && (!Number.isInteger(maxElements) || maxElements < 1)) {
      throw new ServiceError(
        'INVALID_REQUEST',
        `Invalid maxElements ${maxElements}: expected a positive integer.`
      );
    }

    // Byte budget first (spec 10): trim serialized size while keeping
    // document order, then apply the element-count budget. Truncation must
    // happen AFTER ref bridging (which is positional), which is why this
    // lives here and not in the normalizer.
    let elements = observation.elements;
    let truncated = false;
    if (request.maxBytes !== undefined) {
      const budget = request.maxBytes;
      let low = 0;
      let high = elements.length;
      // Binary search for the largest prefix fitting the byte budget.
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const size = JSON.stringify({ ...observation, elements: elements.slice(0, mid) }).length;
        if (size <= budget) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      if (low < elements.length) {
        elements = elements.slice(0, low);
        truncated = true;
      }
    }

    const start = continueFrom ?? 0;
    if (maxElements === undefined) {
      return truncated ? { ...observation, elements, truncated } : observation;
    }

    const slice = elements.slice(start, start + maxElements);
    const remaining = elements.length - (start + slice.length);

    if (remaining <= 0) {
      return { ...observation, elements: slice, truncated };
    }
    return {
      ...observation,
      elements: slice,
      truncated: true,
      continuation: { nextOrdinal: start + slice.length, remaining },
    };
  }

  // ---- actions ------------------------------------------------------------

  async act(
    sessionId: string,
    pageId: string,
    request: ServiceActRequest
  ): Promise<ServiceActResult> {
    return this.traced('act', { sessionId, pageId, action: request.action }, async (span) => {
      const page = this.requirePage(sessionId, pageId);
      this.coordinator.updateActivity(sessionId);

      const ref = request.target?.ref;
      if (ref !== undefined) {
        if (!REF_PATTERN.test(ref)) {
          throw new ServiceError(
            'INVALID_REQUEST',
            `Invalid element reference '${ref}'. Expected e<revision>_<ordinal>, such as e1_0.`,
            false,
            { ref }
          );
        }
        if (!page.lastObservation) {
          throw new ServiceError(
            'INVALID_REQUEST',
            'Observe the page before acting: element refs are minted by observation.',
            false
          );
        }
      }

      await this.checkApproval(sessionId, page, request, span);

      // The adapter projects the engine into service revision space: refs are
      // translated before they reach the engine, and action effects come back
      // stamped with the service's revision rather than the engine's counter.
      // A fill value may be a vault reference: resolve it here, at the last
      // moment, so only the engine ever sees the raw secret.
      const actRequest: ServiceActRequest = { ...request };
      if (
        actRequest.action === 'fill' &&
        actRequest.value !== undefined &&
        this.secretManager.isReference(actRequest.value)
      ) {
        try {
          actRequest.value = await this.secretManager.resolve(actRequest.value);
        } catch (error) {
          const secretError = error as { name?: string; code?: string; message?: string };
          throw this.redactedError(
            secretError?.name === 'SecretError' && secretError.code
              ? new ServiceError(secretError.code, secretError.message ?? 'secret error', false)
              : new ServiceError('INTERNAL', String(error))
          );
        }
      }

      // Wait validation (spec 11.1): unknown conditions are rejected before
      // anything runs; every wait carries a deadline.
      const DELIVERED_WAITS = new Set(['settled', 'domcontentloaded', 'load', 'networkidle']);
      if (request.wait !== undefined && !DELIVERED_WAITS.has(request.wait.until)) {
        throw new ServiceError(
          'INVALID_REQUEST',
          `Unknown wait condition '${request.wait.until}'. Supported: ${[...DELIVERED_WAITS].join(', ')}.`
        );
      }

      const adapter = new RefTranslatingPage(page.enginePage, page);
      const result = await this.executor.execute(
        {
          pageId,
          expectedRevision: actRequest.expectedRevision ?? page.revision,
          action: this.toProtocolAction(actRequest),
        },
        {
          enginePage: adapter,
          observation: this.lastObservationOf(page),
          currentRevision: page.revision,
        }
      );

      if (result.error) {
        // A crash inside the executor surfaces as an INTERNAL whose message
        // names the crash; recover before rethrowing the typed error.
        if (result.error.code === 'INTERNAL' && this.isCrash(result.error.message)) {
          await this.recoverFromCrash(sessionId, 'act: engine crashed');
          throw this.redactedError(
            new ServiceError(
              'ENGINE_CRASHED',
              'The browser engine crashed; the session has been terminated.',
              false,
              { sessionId }
            )
          );
        }
        throw this.redactedError(
          new ServiceError(
            result.error.code,
            result.error.message,
            result.error.retryable,
            result.error.details
          )
        );
      }

      page.revision = result.newRevision;

      // Post-action wait (spec 11.1): an explicit wait runs to its deadline
      // (returns WHY it completed; a missed deadline is ACTION_TIMEOUT,
      // never a hang). Without one, a zero-cost settle yield keeps latency
      // off the deterministic path - engines that need real settling take
      // an explicit wait.
      const waitReason =
        request.wait !== undefined ? await this.waitFor(page.enginePage, request.wait) : 'settled';

      // A requested post-action observation goes through the service's own
      // observe(), so its refs are minted, mapped and immediately actionable.
      let observation: PageState | undefined;
      if (request.observe === 'after') {
        observation = await this.observe(sessionId, pageId, { mode: 'interactive' });
      }

      return {
        status: 'success',
        actionId: result.actionId,
        newRevision: result.newRevision,
        observation,
        waitReason,
      };
    });
  }

  /**
   * Run one wait condition to its deadline (spec 11.1). Returns why it
   * completed. `settled` means a short quiet window on an engine that
   * supports load-state events; engines without the support settle
   * immediately (an explicit, bounded best-effort - recorded in the
   * reason, never a silent hang).
   */
  private async waitFor(
    enginePage: EnginePage,
    wait: { until: string; timeoutMs?: number | undefined }
  ): Promise<string> {
    const deadlineMs = wait.timeoutMs ?? 5000;

    if (wait.until === 'settled') {
      // Quiet-window approximation: wait for the network to go idle via
      // load state where supported, bounded by the deadline.
      const anyPage = enginePage as unknown as {
        waitForLoadState?: (state: string, options: { timeout?: number }) => Promise<void>;
      };
      if (typeof anyPage.waitForLoadState === 'function') {
        try {
          await anyPage.waitForLoadState('networkidle', { timeout: deadlineMs });
        } catch {
          // Deadline hit on a busy page: the action still succeeded; the
          // wait reports settled-at-deadline rather than failing the act.
        }
      }
      return 'settled';
    }

    if (
      wait.until === 'load' ||
      wait.until === 'domcontentloaded' ||
      wait.until === 'networkidle'
    ) {
      const anyPage = enginePage as unknown as {
        waitForLoadState?: (state: string, options: { timeout?: number }) => Promise<void>;
      };
      if (typeof anyPage.waitForLoadState === 'function') {
        try {
          await anyPage.waitForLoadState(wait.until, { timeout: deadlineMs });
        } catch {
          throw new ServiceError(
            'ACTION_TIMEOUT',
            `Wait '${wait.until}' did not complete within ${deadlineMs}ms.`,
            true,
            { until: wait.until, timeoutMs: deadlineMs }
          );
        }
      }
      return wait.until;
    }

    // Unknown conditions are validated before execution; unreachable.
    return 'unknown';
  }

  // ---- pdf ----------------------------------------------------------------

  /**
   * Capture a PDF artifact. Like screenshots, PDFs are evidence: the bytes
   * land in the artifact store scoped to the session.
   */
  async pdf(sessionId: string, pageId: string, request: PdfRequest): Promise<ArtifactMetadata> {
    return this.traced('pdf', { sessionId, pageId }, async () => {
      const page = this.requirePage(sessionId, pageId);
      this.coordinator.updateActivity(sessionId);

      if (page.enginePage.pdf === undefined) {
        throw new ServiceError(
          'ENGINE_UNSUPPORTED',
          'The active engine does not support PDF capture.'
        );
      }

      let captured: Awaited<ReturnType<NonNullable<EnginePage['pdf']>>>;
      try {
        captured = await page.enginePage.pdf(request);
      } catch (error) {
        if (this.isCrash(error instanceof Error ? error.message : String(error))) {
          await this.recoverFromCrash(sessionId, 'pdf: engine crashed');
          throw new ServiceError(
            'ENGINE_CRASHED',
            'The browser engine crashed; the session has been terminated.',
            false,
            { sessionId }
          );
        }
        throw error;
      }

      const bytes = Buffer.from((captured as { bytesBase64?: string }).bytesBase64 ?? '', 'base64');
      return this.artifacts.put('pdf', 'application/pdf', new Uint8Array(bytes), {
        sessionId,
      });
    });
  }

  // ---- downloads ----------------------------------------------------------

  /**
   * Download a payload as a stored artifact. Downloads are denied unless the
   * session was created with allowDownloads, and every target passes the
   * network egress policy like navigation does.
   */
  async download(
    sessionId: string,
    pageId: string,
    request: { url: string; filename?: string }
  ): Promise<ArtifactMetadata> {
    this.requirePage(sessionId, pageId);
    this.coordinator.updateActivity(sessionId);

    const policy = this.sessionDownloadPolicy.get(sessionId);
    if (!policy?.allowDownloads) {
      throw new ServiceError(
        'DOWNLOAD_BLOCKED',
        'Downloads are disabled for this session. Create the session with allowDownloads to enable them.',
        false
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      throw new ServiceError(
        'INVALID_REQUEST',
        `Invalid download URL: ${request.url.slice(0, 100)}`
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ServiceError(
        'POLICY_DENIED',
        `Downloads accept http(s) URLs only; '${parsed.protocol}' is not permitted.`
      );
    }

    try {
      const egress = this.sessionPolicies.get(sessionId) ?? this.rootRequestPolicy;
      await egress.checkRequest({ hostname: parsed.hostname, url: request.url });
    } catch (error) {
      throw this.mapError(error);
    }

    const { bytes, contentType } = await this.downloader(request.url);

    if (bytes.length > policy.maxDownloadBytes) {
      throw new ServiceError(
        'DOWNLOAD_BLOCKED',
        `Payload is ${bytes.length} bytes; this session allows at most ${policy.maxDownloadBytes} bytes.`,
        false,
        { sizeBytes: bytes.length, maxDownloadBytes: policy.maxDownloadBytes }
      );
    }

    try {
      return this.artifacts.put('download', contentType, bytes, {
        ...(request.filename !== undefined ? { filename: request.filename } : {}),
        sessionId,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      throw new ServiceError(
        code === 'ARTIFACT_TOO_LARGE' ? 'DOWNLOAD_BLOCKED' : 'INTERNAL',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Collect a page-initiated download (spec 10) that the engine
   * intercepted. The bytes land in the artifact store like any capture;
   * the egress choke point already vetted the request that fetched them.
   */
  async collectDownload(
    sessionId: string,
    pageId: string,
    filename: string
  ): Promise<ArtifactMetadata> {
    return this.traced('download.collect', { sessionId, pageId, filename }, async () => {
      const page = this.requirePage(sessionId, pageId);
      this.coordinator.updateActivity(sessionId);

      const pull = (
        page.enginePage as unknown as {
          downloadBytes?: (pageId: string, filename: string) => Promise<Uint8Array | undefined>;
        }
      ).downloadBytes;
      const sessionPull = (
        page.enginePage as unknown as {
          session?: {
            downloadBytes?: (pageId: string, filename: string) => Promise<Uint8Array | undefined>;
          };
        }
      ).session;

      const bytes =
        (await pull?.call(page.enginePage, page.enginePage.id, filename)) ??
        (await sessionPull?.downloadBytes?.call(sessionPull, page.enginePage.id, filename));

      if (bytes === undefined) {
        throw new ServiceError(
          'NOT_FOUND',
          `No captured download '${filename}' on this page. Downloads appear as download.finished events; collect after the event fires.`
        );
      }

      const contentType = filename.endsWith('.csv')
        ? 'text/csv'
        : filename.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream';

      return this.artifacts.put('download', contentType, bytes, { filename, sessionId });
    });
  }

  /** Retrieve a stored artifact, scoped to its session. */
  getArtifact(
    sessionId: string,
    artifactId: string
  ): { metadata: ArtifactMetadata; bytes: Uint8Array } | undefined {
    const entry = this.artifacts.get(artifactId);
    if (!entry || entry.metadata.sessionId !== sessionId) {
      return undefined;
    }
    return entry;
  }

  // ---- extraction ---------------------------------------------------------

  /**
   * Deterministic extraction over a fresh observation (spec 12): pure
   * functions over the raw page state, evidence hashed against the source
   * content at the service's revision.
   */
  async extract(
    sessionId: string,
    pageId: string,
    request: {
      format?: 'text' | 'markdown' | 'links' | 'tables' | 'forms' | 'jsonld' | 'schema';
      schema?: Record<string, unknown>;
    }
  ): Promise<import('@agentbrowser/engine').ExtractionResult> {
    return this.traced('extract', { sessionId, pageId, format: request.format }, async () => {
      const page = this.requirePage(sessionId, pageId);
      this.coordinator.updateActivity(sessionId);

      let raw: RawPageState;
      try {
        raw = await page.enginePage.observe({});
      } catch (error) {
        if (this.isCrash(error instanceof Error ? error.message : String(error))) {
          await this.recoverFromCrash(sessionId, 'extract: engine crashed');
          throw new ServiceError(
            'ENGINE_CRASHED',
            'The browser engine crashed; the session has been terminated.',
            false,
            { sessionId }
          );
        }
        throw error;
      }

      // Evidence attests to the service's revision of the page.
      const sourced: RawPageState = {
        ...raw,
        metadata: { ...(raw.metadata ?? {}), revision: page.revision },
      };

      switch (request.format) {
        case 'text':
          return extractVisibleText(sourced);
        case 'markdown':
          return extractMarkdown(sourced);
        case 'links':
          return extractLinks(sourced);
        case 'tables':
          return extractTables(sourced);
        case 'forms':
          return extractForms(sourced);
        case 'jsonld':
          return extractJsonLd(sourced);
        case 'schema': {
          if (request.schema === undefined) {
            throw new ServiceError(
              'INVALID_REQUEST',
              "format 'schema' requires a schema (JSON Schema object)."
            );
          }
          const extractor = new SchemaExtractor({
            ...(this.secretManager !== undefined ? { secretManager: this.secretManager } : {}),
          });
          return await extractor.extract(sourced, request.schema);
        }
        default:
          throw new ServiceError(
            'INVALID_REQUEST',
            `Unknown extraction format: ${String(request.format)}. Supported: text, markdown, links, tables, forms, jsonld.`
          );
      }
    });
  }

  // ---- screenshots --------------------------------------------------------

  async screenshot(
    sessionId: string,
    pageId: string,
    request: ScreenshotRequest
  ): Promise<ArtifactMetadata> {
    const page = this.requirePage(sessionId, pageId);
    this.coordinator.updateActivity(sessionId);

    let captured: Awaited<ReturnType<EnginePage['screenshot']>>;
    try {
      captured = await page.enginePage.screenshot(request);
    } catch (error) {
      if (this.isCrash(error instanceof Error ? error.message : String(error))) {
        await this.recoverFromCrash(sessionId, 'screenshot: engine crashed');
        throw new ServiceError(
          'ENGINE_CRASHED',
          'The browser engine crashed; the session has been terminated.',
          false,
          { sessionId }
        );
      }
      throw error;
    }

    const bytes = Buffer.from((captured as { bytesBase64?: string }).bytesBase64 ?? '', 'base64');
    // maskSensitive honesty (spec 12/16): pixel masking needs element
    // geometry the engines do not expose yet. When values may be on
    // screen and masking was requested, the artifact carries a recorded
    // warning instead of silently implying a masked image.
    const warnings: string[] = [];
    if (request.maskSensitive === true) {
      const observation = page.lastObservation;
      const sensitiveOnPage =
        observation !== undefined &&
        [...observation.byRef.values()].some(
          (element) => element.value !== undefined && element.value !== ''
        );
      if (sensitiveOnPage) {
        warnings.push(
          'maskSensitive requested but pixel masking is not implemented; the screenshot may contain on-screen values. Prefer redacted observations.'
        );
        this.logger?.warn('screenshot.mask-sensitive-unavailable', { sessionId, pageId });
      }
    }

    const metadata = this.artifacts.put('screenshot', captured.contentType, new Uint8Array(bytes), {
      sessionId,
    });
    return warnings.length > 0 ? { ...metadata, warnings } : metadata;
  }

  // ---- shutdown -----------------------------------------------------------

  async shutdown(): Promise<void> {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
    }
    await this.coordinator.shutdown();
    this.pages.clear();
    await this.approvalGate.shutdown();
    await this.engine.close();
  }

  // ---- internals ----------------------------------------------------------

  private requireSession(sessionId: string) {
    const session = this.coordinator.get(sessionId);
    if (!session) {
      throw new ServiceError('SESSION_NOT_FOUND', `Session ${sessionId} does not exist.`);
    }
    return session;
  }

  private requirePage(sessionId: string, pageId: string): PageContext {
    // Session-level failures outrank page-level ones: an expired session is
    // SESSION_NOT_FOUND even if the caller also holds a stale page id.
    if (!this.coordinator.get(sessionId)) {
      throw new ServiceError('SESSION_NOT_FOUND', `Session ${sessionId} does not exist.`);
    }
    const page = this.pages.get(pageId);
    if (!page || page.sessionId !== sessionId) {
      throw new ServiceError('NOT_FOUND', `Page ${pageId} does not exist in session ${sessionId}.`);
    }
    return page;
  }

  /** Gate high-risk elements behind single-use approval tokens (ADR-007). */
  private async checkApproval(
    sessionId: string,
    page: PageContext,
    request: ServiceActRequest,
    span?: import('@agentbrowser/core').Span | undefined
  ): Promise<void> {
    const ref = request.target?.ref;
    if (ref === undefined || !page.lastObservation) {
      return;
    }

    const element = page.lastObservation.byRef.get(ref);
    const risk = element?.risk;
    if (risk === undefined || !HIGH_RISK_EFFECTS.has(risk)) {
      return;
    }

    const approvalRequest = {
      sessionId,
      action: {
        type: request.action,
        effect: risk,
        target: { ref },
        ...(request.value !== undefined ? { value: request.value } : {}),
      },
    };

    if (request.approvalToken !== undefined) {
      const valid = await this.approvalGate.validateApprovalToken(
        request.approvalToken,
        approvalRequest
      );
      if (valid) {
        await this.approvalGate.useApprovalToken(request.approvalToken);
        if (span) {
          this.tracer?.addEvent(span, 'approval.granted', { effect: risk, ref });
        }
        return;
      }
      // Invalid, expired, burned or mismatched token: fall through to a fresh
      // denial with a new token.
    }

    const token = await this.approvalGate.generateApprovalToken(approvalRequest);
    if (span) {
      this.tracer?.addEvent(span, 'approval.required', { effect: risk, ref });
    }
    throw new ServiceError(
      'APPROVAL_REQUIRED',
      `Action targets an element classified '${risk}' and needs an approval token.`,
      false,
      { tokenId: token.tokenId, effect: risk, ref }
    );
  }

  private toProtocolAction(request: ServiceActRequest) {
    const action: Record<string, unknown> = { type: request.action };
    if (request.target !== undefined) action.target = { ref: request.target.ref };
    if (request.value !== undefined) action.value = request.value;
    if (request.key !== undefined) action.key = request.key;
    if (request.direction !== undefined) action.direction = request.direction;
    if (request.amount !== undefined) action.amount = request.amount;
    if (request.promptText !== undefined) action.promptText = request.promptText;
    return action as unknown as Parameters<ActionExecutor['execute']>[0]['action'];
  }

  private lastObservationOf(page: PageContext): PageState {
    // The executor needs an observation for fingerprint checks; a synthetic
    // empty one is safe because untargeted actions skip those checks and
    // targeted ones were gated above (which requires a real observation).
    return (
      (page.lastObservation && {
        sessionId: '',
        pageId: '',
        revision: page.lastObservation.revision,
        url: '',
        title: '',
        status: 'interactive' as const,
        elements: Array.from(page.lastObservation.byRef.values()),
        truncated: false,
        untrustedContent: true,
      }) ?? {
        sessionId: '',
        pageId: '',
        revision: page.revision,
        url: '',
        title: '',
        status: 'interactive' as const,
        elements: [],
        truncated: false,
        untrustedContent: true,
      }
    );
  }

  private hostnameOf(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  /** Strip registered secret values from an error before it leaves the service. */
  private redactedError(error: ServiceError): ServiceError {
    return new ServiceError(
      error.code,
      this.secretManager.redact(error.message),
      error.retryable,
      error.details !== undefined ? this.secretManager.redact(error.details) : undefined
    );
  }

  private mapError(error: unknown): ServiceError {
    if (error instanceof ServiceError) {
      return this.redactedError(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof Error && 'code' in error ? String((error as { code: string }).code) : '';

    if (code === 'QUOTA_EXCEEDED') {
      return new ServiceError('QUOTA_EXCEEDED', message);
    }
    if (message === 'SESSION_NOT_FOUND') {
      return new ServiceError('SESSION_NOT_FOUND', 'Session does not exist.');
    }
    if (code === 'POLICY_DENIED') {
      return new ServiceError(
        'POLICY_DENIED',
        message,
        false,
        (error as { details?: Record<string, unknown> }).details
      );
    }
    return new ServiceError('INTERNAL', message);
  }
}

/** Production download fetcher; tests inject their own. */
const defaultDownloader = async (
  url: string
): Promise<{ bytes: Uint8Array; contentType: string }> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new ServiceError('INTERNAL', `Download failed: HTTP ${response.status}`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  return {
    bytes: buffer,
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
  };
};

/** Redact credentials from a URL before it enters an error payload. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return '<invalid url>';
  }
}

/**
 * Projects the engine page into service space: normalized refs are translated
 * to engine refs on the way in, and action effects come back stamped with the
 * service's revision counter instead of the engine's.
 */
class RefTranslatingPage implements EnginePage {
  readonly id: string;

  constructor(
    private readonly inner: EnginePage,
    private readonly page: PageContext
  ) {
    this.id = inner.id;
  }

  async resolve(target: { ref: string }) {
    const engineRef = this.page.lastObservation?.refMap.get(target.ref);
    if (engineRef === undefined) {
      throw new Error(`Element not found: ${target.ref}`);
    }
    return this.inner.resolve({ ref: engineRef });
  }

  async act(action: { type: string; target?: { ref: string }; [key: string]: unknown }) {
    const oldRevision = this.page.revision;
    const projected = { ...action };
    if (action.target !== undefined) {
      const engineRef = this.page.lastObservation?.refMap.get(action.target.ref);
      if (engineRef !== undefined) {
        projected.target = { ref: engineRef };
      }
    }
    const effect = await this.inner.act(projected);
    // Navigate is handled by navigate(); dialog actions are non-mutating.
    // Everything else advances the service revision.
    const nonMutating =
      action.type === 'navigate' ||
      action.type === 'acceptDialog' ||
      action.type === 'dismissDialog';
    const newRevision = nonMutating ? this.page.revision : this.page.revision + 1;
    return { ...effect, oldRevision, newRevision };
  }

  async navigate(request: { url: string; waitUntil?: string }) {
    return this.inner.navigate(request as never);
  }

  async observe(request: ObservationRequest) {
    return this.inner.observe(request);
  }

  async extract(request: never) {
    return this.inner.extract(request);
  }

  async screenshot(request: ScreenshotRequest) {
    return this.inner.screenshot(request);
  }

  async *events() {
    yield* this.inner.events();
  }

  async close() {
    await this.inner.close();
  }
}

// EngineSession is referenced through the coordinator's SessionContext.
export type { EngineSession };
