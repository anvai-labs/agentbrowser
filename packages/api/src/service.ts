import { isNavigationFailureReason, sessionLeaseRemainingMs } from '@agentbrowser/protocol';
import { type CdpAttachAdmission, requireCdpAttachAdmission } from './cdp-config.js';
import { SessionAuthority } from './session-authority.js';
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
  type ApplicationAdapter,
  ApplicationAuthority,
  type ApplicationReadEvidenceSourceOptions,
  type ApplicationReceiptEvidenceSourceOptions,
  type ApplicationRequest,
  type ApplicationReviewSelector,
  type EvidenceReviewSelector,
  type EvidenceReviewSource,
  NATIVE_FORM_REVIEW_TYPE,
  type OperationPublication,
  type PreparedApplicationConsent,
  type PreparedApplicationOperationReview,
  type PreparedEvidenceReview,
  type PreparedReviewDisclosure,
  type SessionPublication,
  TrustedEvidenceSourceRegistry,
  type TrustedVerifierRegistry,
  captureEvidenceReviewSource,
  captureReviewDisclosure,
  composePublicationContext,
  defineApplicationReadEvidenceSource,
  defineApplicationReceiptEvidenceSource,
  prepareEvidenceReview,
  runVerifiedOutcome,
  selectApplicationReview,
  selectEvidenceReview,
  snapshotAuthorizationInput,
  snapshotPublication,
  synchronousResult,
} from '@agentbrowser/control';
import {
  ActionExecutor,
  ApprovalGate,
  ArtifactStore,
  JsonLedger,
  ObservationNormalizer,
  SecretManager,
  SessionCoordinator,
  SessionState,
  budgetObservation,
  canonicalJson,
} from '@agentbrowser/core';
import type { ApprovalReviewBinding, ArtifactMetadata, SessionContext } from '@agentbrowser/core';
import type { InMemoryTracer, Span } from '@agentbrowser/core';
import type { MetricsRegistry } from '@agentbrowser/core';
import type { StructuredLogger } from '@agentbrowser/core';
import { ActionRiskPolicy, type ActionRiskPolicyOptions } from '@agentbrowser/core';
import {
  type BrowserEngine,
  type EngineEvent,
  type EnginePage,
  type NativeFormEvidence,
  parseNativeFormEvidence,
} from '@agentbrowser/engine';
import type { EngineSession, EngineSessionOptions, NormalizedCookie } from '@agentbrowser/engine';
import type { RawPageState } from '@agentbrowser/engine';
import type { RequestPolicy } from '@agentbrowser/engine';
import {
  type ProtocolErrorCode,
  normalizeEngineError,
  normalizeNavigationFailure,
} from '@agentbrowser/engine';
import { SchemaExtractor } from '@agentbrowser/extraction';
import {
  RecordsSelectorError,
  extractForms,
  extractJsonLd,
  extractLinks,
  extractMarkdown,
  extractRecords,
  extractTables,
  extractVisibleText,
} from '@agentbrowser/extraction';
import { type NetworkPolicy, SessionHostPolicy } from '@agentbrowser/policy';
import type {
  ArtifactRef,
  ObservationRequest,
  OperatorApprovalView,
  OutcomeRunReport,
  OutcomeRunRequest,
  PageElement,
  PageState,
  PdfRequest,
  PlanReport,
  ScreenshotRequest,
} from '@agentbrowser/protocol';
import {
  DEFAULT_EXTRACT_MAX_BYTES,
  DELIVERED_EXTRACT_FORMATS,
  DELIVERED_OBSERVATION_INCLUDES,
  DELIVERED_WAIT_TYPES,
  type DeliveredExtractFormat,
  REF_PATTERN,
  VERIFICATION_SNAPSHOT_LIMITS,
  createOutcomeRunReportParser,
  decodeWireAction,
  parseExtractMaxBytes,
  parseOutcomeRunRequest,
  parseRef,
  snapshotJsonData,
  validateApplicationBinding,
  validateApplicationExecute,
  validateApplicationReview,
  validateDeliveredWaitCondition,
  validateObservationRequest,
  validateScreenshotRequest,
} from '@agentbrowser/protocol';
import { runAutofill } from './autofill.js';
import {
  DownloadBudget,
  DownloadTransport,
  type DownloadTransportOptions,
} from './download-transport.js';
import { createDefaultNetworkPolicy } from './network-policy-config.js';
import type { SessionPrincipal } from './session-authority.js';

/** Typed failure carrying a protocol error code. */
export class ServiceError extends Error {
  constructor(
    public code: ProtocolErrorCode,
    message: string,
    public retryable = false,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface ServiceSessionRequest {
  cdpAttach?: boolean;
  controlMode?: 'delegated';
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
  approval?: import('@agentbrowser/protocol').ApprovalPolicy;
  /**
   * ADR-019: off by default. Explicit per-session acceptance that service
   * workers bypass the egress choke point, for destinations whose anti-fraud
   * tooling keys off service-worker presence.
   */
  allowServiceWorkers?: boolean;
  /**
   * Per-session override (1-30000ms, default 5000) for the whole-page
   * ariaSnapshot budget observe() uses before degrading to a DOM-tag-only
   * fallback. Raise it for a session known to navigate large/complex forms.
   */
  snapshotTimeoutMs?: number;
}

export type ServiceSessionView = import('@agentbrowser/protocol').SessionView;

export interface ServicePageView {
  pageId: string;
  sessionId: string;
  status: string;
  /** Optional best-effort cached URL; may lag navigation and is not security evidence. */
  url?: string;
  title?: string;
  /** Present on popup pages: the service page id of the window.open opener. */
  openerPageId?: string;
}

/**
 * A delivered wait condition (spec 11.1 + F6/F7). Which extra field is
 * meaningful depends on `until`; the service validates that pairing before
 * anything runs.
 */
export interface ServiceWaitCondition {
  until: string;
  timeoutMs?: number | undefined;
  /** urlPattern: glob (wildcards) or a slash-delimited regex. */
  pattern?: string | undefined;
  /** selectorVisible: CSS selector polled for visibility. */
  selector?: string | undefined;
  /** minElements: minimum observed element count. */
  count?: number | undefined;
}

export interface ServiceActRequest {
  action: string;
  target?: { ref: string } | undefined;
  value?: string | undefined;
  /** Native-field comparison after one fill; no write replay. */
  expectValue?: string | undefined;
  values?: string[] | undefined;
  paths?: string[] | undefined;
  sha256?: string | undefined;
  mimeType?: string | undefined;
  deltaX?: number | undefined;
  deltaY?: number | undefined;
  key?: string | undefined;
  direction?: 'up' | 'down' | 'left' | 'right' | undefined;
  amount?: number | undefined;
  observe?: 'after' | 'none' | undefined;
  expectedRevision?: number | undefined;
  approvalToken?: string | undefined;
  /** Prompt answer for acceptDialog. */
  promptText?: string | undefined;
  /** Per-character delay for typeText keystrokes (0-1000ms). */
  delay?: number | undefined;
  /** Post-action wait condition (spec 11.1). */
  wait?: ServiceWaitCondition | undefined;
  /** Wait-action condition (the `wait` ACTION; distinct from post-action wait). */
  condition?: ServiceWaitCondition | undefined;
  /** F2: opt-in healing when the targeted control was replaced. */
  remap?: boolean | undefined;
  /**
   * TD-BROWSER-8 Phase 2: wait (before this plan step runs) until an
   * element whose name contains this substring appears - for fields
   * revealed by a prior step. Plan-step-only; never forwarded to
   * toProtocolAction. Bounded by waitMs (default 5000ms).
   */
  waitForLabel?: string | undefined;
  waitMs?: number | undefined;
  /**
   * F3: batch envelope - a bounded 1..20 step sequence run through
   * executePlan's machinery. Exclusive with `action`; when present, act()
   * dispatches to the batch path before anything reads `action`.
   */
  steps?: ServiceActRequest[] | undefined;
}

export interface ServiceActResult {
  status: 'success';
  actionId: string;
  newRevision: number;
  observation?: PageState | undefined;
  /** Why the post-action wait completed (spec 11.1). */
  waitReason?: string | undefined;
  /** Present only when the engine healed a replaced target (F2). */
  remap?: { from: string; to: string } | undefined;
  /** Evidence payload, present only for actions that produce one (upload: attached files). */
  result?: unknown;
}

/** One step's outcome inside a batch (F3); failures are in-band. */
export interface ServiceBatchStepResult {
  step: number;
  ok: boolean;
  actionId?: string;
  /** Present when this step was healed by the opt-in remap (F2). */
  remap?: { from: string; to: string } | undefined;
  /** Per-action evidence (upload: attached files), matching single-act. */
  result?: unknown;
  error?: string;
}

export interface ServiceBatchActResult {
  status: 'success' | 'failed';
  completed: number;
  results: ServiceBatchStepResult[];
  oldRevision: number;
  newRevision: number;
  mode: 'stable' | 'verified';
  waitReason?: string | undefined;
  observation?: PageState | undefined;
  error?: { code: string; message: string } | undefined;
}

/** Public-safe identity passed to trusted evidence-review composition. */
export interface ServiceEvidenceReviewRequest {
  readonly application?: ApplicationReviewSelector;
  readonly identity: Readonly<{
    tenant: string;
    sessionId: string;
    sessionIncarnation: string;
    pageId: string;
  }>;
  readonly source: Readonly<{
    ownerId: string;
    contract: Readonly<{ id: string; version: string }>;
  }>;
}

/** Trusted host observation scoped to the current review admission, never client supplied. */
export interface ServiceEvidenceReviewContext {
  readonly nativeForm: PreparedNativeFormRead;
}

export interface ServiceDependencies {
  /** Trusted startup capability. Absent means disabled. */
  cdpAttachAdmission?: CdpAttachAdmission;
  /** Operator-owned maximum complete extraction response bytes. */
  extractMaxBytes?: number;
  approvalPolicy?: ActionRiskPolicyOptions;
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
  downloader?(
    url: string,
    options: DownloadTransportOptions
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Operation tracer; absent means tracing is disabled. */
  tracer?: InMemoryTracer;
  /** Operation metrics; absent means metrics are disabled. */
  metrics?: MetricsRegistry;
  /** Structured operation log; absent means no operation logging. */
  logger?: StructuredLogger;
  /** How often to reconcile service state with coordinator expiry (ms). */
  sweepIntervalMs?: number;
  /**
   * Operator-level session defaults (env-plumbed via bin.ts). A request
   * still overrides either per session; these just move the baseline for
   * deployments whose workloads systematically need longer (e.g. headed
   * human-in-the-loop flows vs the 10-min default idle).
   */
  defaultTtlMs?: number;
  defaultIdleTimeoutMs?: number;
  /** Trusted deployment-owned verification definitions; never populated by requests. */
  verifierRegistry?: TrustedVerifierRegistry;
  /** Trusted read-only evidence adapters paired to verifier capabilities. */
  evidenceSourceRegistry?: TrustedEvidenceSourceRegistry<ServiceOutcomeEvidenceContext>;
  /**
   * Build evidence sources after the service-owned ApplicationAuthority exists.
   * Mutually exclusive with a prebuilt evidenceSourceRegistry.
   */
  evidenceSourceRegistryProvider?: (
    sources: ServiceEvidenceSourceBuilder
  ) => TrustedEvidenceSourceRegistry<ServiceOutcomeEvidenceContext>;
  /**
   * Trusted application adapters for the shared-infra application surface.
   * The service composes the ApplicationAuthority over its own
   * SessionAuthority - bindings key on the authority's SessionControl
   * objects, so an externally built authority could never see them.
   */
  applicationAdapters?: readonly ApplicationAdapter[];
  /**
   * Synchronous trusted deployment composition for public evidence reviews.
   * The returned collector may use context.nativeForm within this admission only.
   */
  evidenceReviewProvider?: (
    request: ServiceEvidenceReviewRequest,
    context: ServiceEvidenceReviewContext
  ) => { action: Record<string, unknown>; source: EvidenceReviewSource } | undefined;
}

/** Minimum context exposed to a trusted evidence adapter. */
export interface ServiceOutcomeEvidenceContext {
  readonly sessionId: string;
  readonly pageId: string;
  readonly tenantId?: string;
  readonly signal: AbortSignal;
}

/** Narrow lazy source factory; it exposes no raw authority or receipt reader. */
export interface ServiceEvidenceSourceBuilder {
  applicationReceipt(
    config: ApplicationReceiptEvidenceSourceOptions
  ): ReturnType<typeof defineApplicationReceiptEvidenceSource<ServiceOutcomeEvidenceContext>>;
  applicationRead(
    config: ApplicationReadEvidenceSourceOptions
  ): ReturnType<typeof defineApplicationReadEvidenceSource<ServiceOutcomeEvidenceContext>>;
}

/** Admission-owned reader for a bounded native form witness. */
export interface PreparedNativeFormRead {
  readonly identity: Readonly<{
    sessionId: string;
    pageId: string;
    sessionIncarnation: string;
  }>;
  assertAuthority(): void;
  readonly publication: Readonly<{ assertCurrent(): void }>;
  read(signal?: AbortSignal): Promise<NativeFormEvidence>;
}

interface PageContext {
  sessionId: string;
  enginePage: EnginePage;
  /** Service page id of the window.open opener, when adopted as a popup. */
  openerPageId?: string;
  revision: number;
  /** The last observation handed to a client, in service revision space. */
  lastObservation?:
    | {
        revision: number;
        url: string;
        engineRevision?: number;
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
  include?: string[] | undefined;
  /** Optional readiness wait applied BEFORE the snapshot (SPA readiness). */
  wait?: ServiceWaitCondition | undefined;
};

/** Optional observation enrichments the stack actually delivers. */
const DELIVERED_INCLUDES = new Set<string>(DELIVERED_OBSERVATION_INCLUDES);

export class AgentBrowserService {
  readonly authority = new SessionAuthority();
  /**
   * Composed over this service's own SessionAuthority; without adapters
   * every application operation still fails closed (bind rejects, no
   * binding can exist), so the surface is inert until a deployment opts in.
   */
  readonly applicationAuthority: ApplicationAuthority;
  private readonly controlledContexts = new WeakSet<SessionContext>();
  private readonly cdpAttachAdmission: CdpAttachAdmission;
  private readonly engine: BrowserEngine;
  private readonly extractMaxBytes: number;
  private readonly engines: Map<string, BrowserEngine> = new Map();
  private readonly coordinator: SessionCoordinator;
  private readonly normalizer: ObservationNormalizer;
  private readonly executor: ActionExecutor;
  private readonly networkPolicy: NetworkPolicy;
  private readonly approvalGate: ApprovalGate;
  private readonly secretManager: SecretManager;
  private readonly artifacts: ArtifactStore;
  private readonly downloader: ServiceDependencies['downloader'];
  private readonly downloadBudget = new DownloadBudget();
  private readonly downloads = new Map<string, DownloadTransport>();
  private shuttingDown = false;
  private readonly tracer?: InMemoryTracer;
  private readonly metrics?: MetricsRegistry;
  private readonly logger?: StructuredLogger;
  private readonly verifierRegistry: TrustedVerifierRegistry | undefined;
  private readonly evidenceSourceRegistry:
    | TrustedEvidenceSourceRegistry<ServiceOutcomeEvidenceContext>
    | undefined;
  private readonly evidenceReviewProvider: ServiceDependencies['evidenceReviewProvider'];
  /** Per-session download policy, captured at creation (denying by default). */
  private readonly sessionDownloadPolicy = new Map<
    string,
    { allowDownloads: boolean; maxDownloadBytes: number }
  >();
  /** Per-session egress chain (fast-fail + engine choke point, one verdict). */
  private readonly sessionPolicies = new Map<string, RequestPolicy>();
  private readonly sessionApprovalPolicies = new Map<
    string,
    import('@agentbrowser/protocol').ApprovalPolicy
  >();
  private readonly actionRiskPolicy: ActionRiskPolicy;
  private readonly pages = new Map<string, PageContext>();
  private pageCounter = 0;
  /** Audit log of sessions terminated by engine crashes (TD-024). */
  private readonly crashLog: Array<{
    sessionId: string;
    reason: string;
    errorDetail?: string;
    timestamp: string;
  }> = [];
  /** Session -> event listeners, fed by per-page engine event pumps. */
  private readonly eventListeners = new Map<string, Set<(event: EngineEvent) => void>>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: ServiceDependencies) {
    this.cdpAttachAdmission = deps.cdpAttachAdmission ?? 'disabled';
    this.extractMaxBytes = parseExtractMaxBytes(deps.extractMaxBytes ?? DEFAULT_EXTRACT_MAX_BYTES);
    const { evidenceReviewProvider, evidenceSourceRegistry, evidenceSourceRegistryProvider } = deps;
    if (evidenceReviewProvider !== undefined && typeof evidenceReviewProvider !== 'function')
      throw new Error('Invalid evidence review provider');
    this.evidenceReviewProvider = evidenceReviewProvider;
    if (evidenceSourceRegistry !== undefined && evidenceSourceRegistryProvider !== undefined)
      throw new Error('Evidence source registry and provider are mutually exclusive');
    this.applicationAuthority = new ApplicationAuthority(
      this.authority,
      deps.applicationAdapters ?? [],
      { consentPolicy: (review, tokenId) => this.prepareApplicationConsent(review, tokenId) }
    );
    if (evidenceSourceRegistryProvider !== undefined) {
      if (typeof evidenceSourceRegistryProvider !== 'function')
        throw new Error('Invalid evidence source registry provider');
      const applicationAuthority = this.applicationAuthority;
      const sources: ServiceEvidenceSourceBuilder = Object.freeze({
        applicationReceipt: (config: ApplicationReceiptEvidenceSourceOptions) =>
          defineApplicationReceiptEvidenceSource<ServiceOutcomeEvidenceContext>(
            applicationAuthority,
            config
          ),
        applicationRead: (config: ApplicationReadEvidenceSourceOptions) =>
          defineApplicationReadEvidenceSource<ServiceOutcomeEvidenceContext>(
            applicationAuthority,
            config
          ),
      });
      const registry = evidenceSourceRegistryProvider(sources);
      if (
        registry !== null &&
        (typeof registry === 'object' || typeof registry === 'function') &&
        'then' in registry &&
        typeof registry.then === 'function'
      ) {
        void Promise.resolve(registry).catch(() => undefined);
        throw new Error('Evidence source registry provider must be synchronous');
      }
      if (!(registry instanceof TrustedEvidenceSourceRegistry))
        throw new Error('Evidence source registry provider returned an invalid registry');
      this.evidenceSourceRegistry = registry;
    } else {
      this.evidenceSourceRegistry = evidenceSourceRegistry;
    }
    this.actionRiskPolicy = new ActionRiskPolicy(deps.approvalPolicy);
    this.engine = deps.engine;
    for (const [name, engine] of Object.entries(deps.engines ?? {})) {
      this.engines.set(name, engine);
    }
    this.coordinator =
      deps.coordinator ??
      new SessionCoordinator({
        cleanupCheckIntervalMs: 3_600_000,
        ...(deps.defaultTtlMs !== undefined ? { defaultTtlMs: deps.defaultTtlMs } : {}),
        ...(deps.defaultIdleTimeoutMs !== undefined
          ? { defaultIdleTimeoutMs: deps.defaultIdleTimeoutMs }
          : {}),
        // Hygiene G2: previously this background cleanup path had no way
        // to reach the service's injected logger and fell back to
        // console.error, invisible in a production log pipeline.
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      });
    this.normalizer = deps.normalizer ?? new ObservationNormalizer();
    this.executor = deps.executor ?? new ActionExecutor(this.normalizer);
    // SSRF defenses are on by default (ADR-006): loopback, private ranges and
    // cloud metadata endpoints are blocked unless a policy is injected.
    this.networkPolicy = deps.networkPolicy ?? createDefaultNetworkPolicy();
    this.approvalGate =
      deps.approvalGate ??
      new ApprovalGate({
        cleanupIntervalMs: 3_600_000,
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      });
    // An empty registry redacts nothing; a populated one is enforced at every
    // output boundary (observations, error messages, error details).
    this.secretManager = deps.secretManager ?? new SecretManager();
    this.artifacts = deps.artifactStore ?? new ArtifactStore();
    this.downloader = deps.downloader;
    this.verifierRegistry = deps.verifierRegistry;
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
        this.deleteSessionState(sessionId);
      }
    }
  }

  /**
   * Drop every per-session/page tracked resource for a session. The one
   * place the teardown set is expressed, so a new tracked map cannot
   * reintroduce the leak class TD-BROWSER-9 (A8) closed.
   */
  private deleteSessionState(sessionId: string): void {
    this.authority.remove(sessionId);
    this.downloads.get(sessionId)?.revoke(new ServiceError('SESSION_NOT_FOUND', 'Session closed'));
    this.downloads.delete(sessionId);
    for (const [pageId, page] of this.pages) {
      if (page.sessionId === sessionId) {
        this.pages.delete(pageId);
        this.churn.delete(this.churnKey(sessionId, pageId));
      }
    }
    this.eventListeners.delete(sessionId);
    this.eventHistory.delete(sessionId);
    this.requestHistory.delete(sessionId);
    this.sessionDownloadPolicy.delete(sessionId);
    this.sessionPolicies.delete(sessionId);
    this.sessionApprovalPolicies.delete(sessionId);
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
    const span = this.tracer?.startSpan(name, this.secretManager.redact(attributes));
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
        const mapped = this.mapError(error, name);
        const code = mapped.code;
        this.telemetry(name, 'error', attributes, startedAt, code);
        if (span) {
          this.tracer?.failSpan(
            span,
            code,
            this.secretManager.redact(error instanceof Error ? error.message : String(error))
          );
          this.tracer?.endSpan(span);
        }
        throw this.redactedError(mapped);
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
      const fields: Record<string, unknown> = this.secretManager.redact({ ...attributes, outcome });
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
  /**
   * A3 evidence: bounded per-session event history (the spec's
   * "per-session event ledger"). Every engine event crosses pumpEvents;
   * console lines replay from here for late subscribers.
   */
  private readonly eventHistory = new Map<string, JsonLedger<EngineEvent>>();
  private static readonly EVENT_HISTORY_LIMIT = 500;
  /**
   * Request lifecycle events get their OWN bounded ledger (spec 5.1
   * network summary): a subresource-heavy page emits dozens of requests
   * per navigation, and sharing the console ledger would evict exactly
   * the console lines the replay buffer exists for.
   */
  private readonly requestHistory = new Map<string, JsonLedger<EngineEvent>>();
  private static readonly REQUEST_HISTORY_LIMIT = 1000;
  /**
   * F10 guard: a page gone wild with window.open must not translate into
   * unbounded service pages. Further popups are closed engine-side.
   */
  private static readonly MAX_POPUPS_PER_SESSION = 20;
  /**
   * F10 guard: adoption is async (it round-trips the engine's page list),
   * so concurrent page.created events would otherwise race on the
   * first-unknown-page selection. Chained per session, adoptions run in
   * event order and observe each other's registrations.
   */
  private readonly adoptionChains = new Map<string, Promise<void>>();

  private recordEvent(sessionId: string, event: EngineEvent): boolean {
    const isRequest = event.type.startsWith('request.');
    const store = isRequest ? this.requestHistory : this.eventHistory;
    const limit = isRequest
      ? AgentBrowserService.REQUEST_HISTORY_LIMIT
      : AgentBrowserService.EVENT_HISTORY_LIMIT;
    let buffer = store.get(sessionId);
    if (buffer === undefined) {
      buffer = new JsonLedger<EngineEvent>({
        maxEntries: limit,
        maxBytes: isRequest ? 2 * 1024 * 1024 : 1024 * 1024,
        maxEntryBytes: 64 * 1024,
      });
      store.set(sessionId, buffer);
    }
    const before = buffer.stats;
    const accepted = buffer.push(event);
    if (!accepted)
      this.metrics?.incrementCounter('events_dropped_total', {
        ledger: isRequest ? 'request' : 'other',
        reason: 'oversized',
      });
    const evictions = buffer.stats.evicted - before.evicted;
    for (let index = 0; index < evictions; index++)
      this.metrics?.incrementCounter('events_evicted_total', {
        ledger: isRequest ? 'request' : 'other',
      });
    return accepted;
  }

  getSessionEventStats(sessionId: string) {
    this.requireSession(sessionId);
    const empty = { entries: 0, bytes: 0, dropped: 0, evicted: 0 };
    return {
      other: this.eventHistory.get(sessionId)?.stats ?? empty,
      request: this.requestHistory.get(sessionId)?.stats ?? empty,
    };
  }

  /**
   * Recent events for a session, oldest first per ledger. A `request.*`
   * type filter serves the request ledger; no filter returns both ledgers
   * (console/other first, then requests - cross-ledger interleaving order
   * is not preserved, documented at the route).
   */
  getSessionEvents(sessionId: string, typeFilter?: string): EngineEvent[] {
    this.requireSession(sessionId);
    const others = this.eventHistory.get(sessionId)?.toArray() ?? [];
    const requests = this.requestHistory.get(sessionId)?.toArray() ?? [];
    if (typeFilter?.startsWith('request.')) {
      return requests.filter((event) => event.type === typeFilter);
    }
    if (typeFilter !== undefined) {
      return others.filter((event) => event.type === typeFilter);
    }
    return [...others, ...requests];
  }

  private canPublishEvents(sessionId: string, owner: SessionContext): boolean {
    if (this.coordinator.get(sessionId) !== owner || owner.signal.aborted) return false;
    return (
      !this.controlledContexts.has(owner) ||
      this.authority.get(sessionId)?.view().state === 'AGENT_ACTIVE'
    );
  }

  private pumpEvents(sessionId: string, pageId: string, enginePage: EnginePage): void {
    const owner = this.requireSession(sessionId);
    void (async () => {
      let sawDestroyed = false;
      try {
        for await (const event of enginePage.events()) {
          if (this.coordinator.get(sessionId) !== owner || owner.signal.aborted) break;
          const stamped: EngineEvent = this.secretManager.redact({
            ...event,
            sessionId,
            pageId,
            ...(event.data !== undefined
              ? { data: this.secretManager.redactUntrusted(event.data) }
              : {}),
          });
          if (stamped.type === 'page.created') {
            this.adoptPopupSerialized(sessionId, stamped.data).catch(() => {
              // Adoption is best-effort; the popup stays engine-side only.
            });
          } else if (stamped.type === 'page.destroyed') {
            sawDestroyed = true;
            this.reapPage(sessionId, pageId);
          }
          if (!this.canPublishEvents(sessionId, owner)) continue;
          if (!this.recordEvent(sessionId, stamped)) continue;
          const listeners = this.eventListeners.get(sessionId);
          if (listeners) {
            for (const listener of [...listeners]) {
              if (!this.canPublishEvents(sessionId, owner)) break;
              try {
                listener(structuredClone(stamped));
              } catch {
                // A misbehaving listener never breaks the stream.
              }
            }
          }
        }
      } catch {
        // The engine page went away; the pump simply ends.
      }
      // Real engines close pages without announcing it - the stream just
      // ends. Fan the declared page.destroyed so replay and WS clients see
      // the same lifecycle for every engine. Gated on an EXISTING ledger:
      // recordEvent creates on demand, so a pump outliving its session
      // (teardown or crash-recovery race) would otherwise resurrect a
      // deleted ledger with a lone synthetic event.
      if (
        !sawDestroyed &&
        this.eventHistory.has(sessionId) &&
        this.canPublishEvents(sessionId, owner)
      ) {
        const synthesized: EngineEvent = this.secretManager.redact({
          type: 'page.destroyed',
          timestamp: new Date().toISOString(),
          sessionId,
          pageId,
          data: { reason: 'streamEnded' },
        });
        if (this.recordEvent(sessionId, synthesized)) {
          const listeners = this.eventListeners.get(sessionId);
          if (listeners) {
            for (const listener of [...listeners]) {
              if (!this.canPublishEvents(sessionId, owner)) break;
              try {
                listener(structuredClone(synthesized));
              } catch {
                // A misbehaving listener never breaks the stream.
              }
            }
          }
        }
      }
      // Stream ended (page closed engine-side): drop the registry entry so
      // listPages stops reporting a dead page id.
      this.reapPage(sessionId, pageId);
    })();
  }

  /**
   * Adopt a page the engine created on its own (a popup): register it in
   * service page space under its opener and start its event pump. The
   * popup never round-trips through createPage; listPages is the client's
   * discovery path to its id.
   */
  /**
   * Serialize a session's adoptions: each page.created is adopted after the
   * previous one settles, in event order, so concurrent popups cannot race
   * on the engine page list. Never throws; the pump keeps flowing.
   */
  private adoptPopupSerialized(sessionId: string, data: unknown): Promise<void> {
    const previous = this.adoptionChains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.adoptPopup(sessionId, data))
      .finally(() => {
        if (this.adoptionChains.get(sessionId) === next) {
          this.adoptionChains.delete(sessionId);
        }
      });
    this.adoptionChains.set(sessionId, next);
    return next;
  }

  private async adoptPopup(sessionId: string, data: unknown): Promise<void> {
    const payload = data as { openerPageId?: unknown; pageId?: unknown } | null;
    const openerEnginePageId = payload?.openerPageId;
    const popupEnginePageId = payload?.pageId;
    if (typeof openerEnginePageId !== 'string' || typeof popupEnginePageId !== 'string') {
      return;
    }
    const owned = [...this.pages.entries()].filter(([, page]) => page.sessionId === sessionId);
    const opener = owned.find(([, page]) => page.enginePage.id === openerEnginePageId);
    if (opener === undefined) {
      return; // Opener already gone; nothing to attach the popup under.
    }
    // Idempotence: a replayed or raced page.created must not double-register.
    if (owned.some(([, page]) => page.enginePage.id === popupEnginePageId)) {
      return;
    }
    // Cap: runaway popup storms are closed engine-side, never adopted.
    const popupCount = owned.filter(([, page]) => page.openerPageId !== undefined).length;
    if (popupCount >= AgentBrowserService.MAX_POPUPS_PER_SESSION) {
      this.metrics?.incrementCounter('popups_rejected_total', { sessionId });
      this.logger?.warn('popup.cap-reached', {
        sessionId,
        cap: AgentBrowserService.MAX_POPUPS_PER_SESSION,
      });
      try {
        const engineSession = this.requireSession(sessionId).engineSession;
        const stray = (await engineSession.pages()).find((page) => page.id === popupEnginePageId);
        await stray?.close();
      } catch {
        // Engine gone or close failed; nothing further to do.
      }
      return;
    }
    let popup: EnginePage | undefined;
    try {
      const engineSession = this.requireSession(sessionId).engineSession;
      popup = (await engineSession.pages()).find((page) => page.id === popupEnginePageId);
    } catch {
      return; // The engine session is gone; nothing to adopt.
    }
    if (popup === undefined) {
      return;
    }
    const popupPageId = `pg_${++this.pageCounter}_${popup.id}`;
    this.pages.set(popupPageId, {
      sessionId,
      enginePage: this.guardPage(sessionId, popup),
      revision: 1,
      history: new Map(),
      openerPageId: opener[0],
    });
    this.pumpEvents(sessionId, popupPageId, popup);
  }

  /** Drop a page's registry and churn state (page.destroyed or pump end). */
  private reapPage(sessionId: string, pageId: string): void {
    const page = this.pages.get(pageId);
    if (page?.sessionId === sessionId) {
      this.pages.delete(pageId);
    }
    this.churn.delete(this.churnKey(sessionId, pageId));
  }

  private isCrash(error: unknown): boolean {
    return normalizeEngineError(error).code === 'ENGINE_CRASHED';
  }

  /**
   * Terminate a session after an engine crash: drop its pages, remove it
   * from tracking, close the engine session best-effort, and record the
   * event for the cleanup audit.
   *
   * `errorDetail` is the underlying engine error's message (e.g. "Target
   * page, context or browser has been closed") — without it, every crash
   * looks identical in the logs and crash audit ("navigate: engine
   * crashed") regardless of what actually killed the browser.
   */
  private async recoverFromCrash(
    sessionId: string,
    reason: string,
    errorDetail?: string
  ): Promise<void> {
    this.deleteSessionState(sessionId);
    await this.coordinator.terminate(sessionId, SessionState.ENGINE_CRASHED, reason).catch(() => {
      // The session may already be gone; the audit entry stands.
    });
    this.metrics?.incrementCounter('sessions_crashed_total');
    this.logger?.error('session.crashed', { sessionId, reason, errorDetail });
    this.crashLog.push({
      sessionId,
      reason,
      ...(errorDetail !== undefined ? { errorDetail } : {}),
      timestamp: new Date().toISOString(),
    });
  }

  /** Crash audit: which sessions died, why, and when. */
  getCrashLog(): ReadonlyArray<{
    sessionId: string;
    reason: string;
    errorDetail?: string;
    timestamp: string;
  }> {
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

  async createSession(input: ServiceSessionRequest): Promise<ServiceSessionView> {
    const request = { ...input, ...(input.approval ? { approval: { ...input.approval } } : {}) };
    if (
      request.approval?.review !== undefined &&
      (request.approval.review !== 'operator' ||
        request.controlMode !== 'delegated' ||
        !request.tenantId)
    )
      throw new ServiceError('INVALID_REQUEST', 'Operator review requires a controlled session');
    if (request.cdpAttach === true) {
      if (
        request.controlMode !== undefined ||
        request.headless !== undefined ||
        request.viewport !== undefined ||
        request.locale !== undefined ||
        request.timezoneId !== undefined ||
        request.cookies !== undefined ||
        request.allowDownloads === true ||
        request.allowedHosts !== undefined ||
        request.blockedHosts !== undefined ||
        request.allowServiceWorkers !== undefined ||
        request.maxDownloadBytes !== undefined ||
        request.approval !== undefined ||
        (request.engine !== undefined &&
          request.engine !== 'auto' &&
          request.engine !== this.engine.name)
      )
        throw new ServiceError(
          'INVALID_REQUEST',
          'Operator attachment cannot apply launch, cookie, delegated-control, download, or per-session policy options. Use a normal isolated session for those options.'
        );
      try {
        requireCdpAttachAdmission(this.cdpAttachAdmission);
      } catch (error) {
        throw this.mapError(error);
      }
      if ((await this.engine.capabilities()).supportsCdpAttach !== true)
        throw new ServiceError(
          'ENGINE_UNSUPPORTED',
          'The configured engine does not support operator attachment.',
          false,
          { reason: 'CDP_ATTACH_UNSUPPORTED' }
        );
    }
    // Validate tenant ID format (lightweight security)
    this.validateTenantId(request.tenantId);

    return this.traced('session.create', { tenantId: request.tenantId ?? '' }, async () => {
      if (this.shuttingDown)
        throw new ServiceError('SESSION_NOT_FOUND', 'Service is shutting down');
      // Snapshot before awaiting engine creation; all session consumers share it.
      const basePolicy = request.allowDownloads
        ? this.networkPolicy.snapshot()
        : this.networkPolicy;
      const engineRequest: EngineSessionOptions & { engine: 'auto' } = { engine: 'auto' };
      if (request.cdpAttach === true) engineRequest.cdpAttach = true;
      engineRequest.downloadPolicy = {
        allow: request.allowDownloads ?? false,
        maxBytes: request.maxDownloadBytes ?? 10 * 1024 * 1024,
      };
      const engine = this.resolveEngine(request.engine);
      if (request.viewport !== undefined) engineRequest.viewport = request.viewport;
      if (request.locale !== undefined) engineRequest.locale = request.locale;
      if (request.timezoneId !== undefined) engineRequest.timezoneId = request.timezoneId;
      if (request.headless !== undefined) engineRequest.headless = request.headless;
      if (request.cookies !== undefined) engineRequest.cookies = request.cookies;
      if (request.allowServiceWorkers !== undefined)
        engineRequest.allowServiceWorkers = request.allowServiceWorkers;
      if (request.snapshotTimeoutMs !== undefined)
        engineRequest.snapshotTimeoutMs = request.snapshotTimeoutMs;

      // Per-session chain: session rules restrict; the SSRF base always runs.
      const sessionPolicy =
        request.allowedHosts !== undefined || request.blockedHosts !== undefined
          ? new SessionHostPolicy(basePolicy, {
              ...(request.allowedHosts !== undefined ? { allowedHosts: request.allowedHosts } : {}),
              ...(request.blockedHosts !== undefined ? { blockedHosts: request.blockedHosts } : {}),
            })
          : basePolicy;

      let allocation: Awaited<ReturnType<SessionCoordinator['createOwned']>>;
      try {
        allocation = await this.coordinator.createOwned(
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

      const { response: session, context } = allocation;
      try {
        const inspection = this.coordinator.inspect(session.sessionId);
        if (
          this.shuttingDown ||
          !context ||
          inspection?.context !== context ||
          context.signal.aborted
        ) {
          throw new ServiceError('SESSION_NOT_FOUND', 'Session ended during creation');
        }
        if (request.allowDownloads)
          this.downloads.set(
            session.sessionId,
            new DownloadTransport(
              {
                policy: sessionPolicy,
                budget: this.downloadBudget,
                admission: this.downloadBudget.connections.createSessionScope(8, context.signal),
                signal: context.signal,
                onOutcome: (outcome) => {
                  const fields = this.secretManager.redact({
                    sessionId: session.sessionId,
                    ...outcome,
                  });
                  if (outcome.outcome === 'error') this.logger?.warn('download.transport', fields);
                  else this.logger?.info('download.transport', fields);
                },
                onCleanupFailure: (fields) =>
                  this.logger?.warn(
                    'download.cleanup-failed',
                    this.secretManager.redact({ sessionId: session.sessionId, ...fields })
                  ),
              },
              this.downloader ? { fetch: this.downloader } : {}
            )
          );

        if (request.controlMode === 'delegated') {
          this.authority.register(session.sessionId, request.tenantId ?? '', context.signal);
          this.controlledContexts.add(context);
        }

        this.sessionDownloadPolicy.set(session.sessionId, {
          allowDownloads: request.allowDownloads === true,
          maxDownloadBytes: request.maxDownloadBytes ?? 10 * 1024 * 1024,
        });
        this.sessionPolicies.set(session.sessionId, sessionPolicy);
        this.sessionApprovalPolicies.set(session.sessionId, { ...request.approval });

        const finalInspection = this.coordinator.inspect(session.sessionId);
        if (!finalInspection || finalInspection.context !== context || context.signal.aborted) {
          throw new ServiceError('SESSION_NOT_FOUND', 'Session ended during creation');
        }
        const result = this.sessionView(context, finalInspection.lease, true);
        this.metrics?.incrementCounter('sessions_created_total');
        this.metrics?.setGauge('sessions_active', this.coordinator.getSessionCount());
        return result;
      } catch (error) {
        const current = this.coordinator.captureForCleanup(session.sessionId);
        if (context && (current === context || current === undefined)) {
          try {
            this.deleteSessionState(session.sessionId);
          } finally {
            await this.coordinator.discardIfCurrent(context, 'creation_failed');
          }
        }
        throw error;
      }
    });
  }

  /** Live pages are keyed by pageId and carry their owning sessionId. */
  invalidateControlObservations(sessionId: string): void {
    for (const page of this.pages.values()) {
      if (page.sessionId !== sessionId) continue;
      page.revision++;
      page.lastObservation = undefined;
      page.history.clear();
    }
    this.eventHistory.delete(sessionId);
    this.requestHistory.delete(sessionId);
  }

  private countPages(sessionId: string): number {
    let count = 0;
    for (const page of this.pages.values()) {
      if (page.sessionId === sessionId) {
        count += 1;
      }
    }
    return count;
  }

  /** Internal lifetime classification; authority removal never makes a controlled session legacy. */
  requiresSessionAuthority(sessionId: string): boolean {
    const context = this.coordinator.get(sessionId);
    return context !== undefined && this.controlledContexts.has(context);
  }

  getSession(sessionId: string): ServiceSessionView | undefined {
    const inspection = this.coordinator.inspect(sessionId);
    return inspection ? this.sessionView(inspection.context, inspection.lease, true) : undefined;
  }

  /** Internal post-close lookup; transport code must authorize ownerTenant before projection. */
  inspectTerminalSession(sessionId: string) {
    return this.coordinator.inspectTerminal(sessionId);
  }

  private sessionView(
    context: SessionContext,
    lease: import('@agentbrowser/protocol').SessionLease | undefined,
    includeTenant: boolean
  ): ServiceSessionView {
    return {
      sessionId: context.id,
      status: context.state.toLowerCase(),
      engine: { ...context.engineIdentity },
      createdAt: new Date(context.metadata.createdAt).toISOString(),
      ttlMs: context.metadata.ttlMs,
      idleTimeoutMs: context.metadata.idleTimeoutMs,
      ...(lease ? { lease } : {}),
      ...(lease
        ? {
            leaseRemainingMs: sessionLeaseRemainingMs(lease),
          }
        : context.terminal
          ? { leaseRemainingMs: 0 }
          : {}),
      ...(context.terminal ? { closeCause: context.terminal.closeCause } : {}),
      pages: this.countPages(context.id),
      ...(context.diagnostics !== undefined ? { diagnostics: context.diagnostics } : {}),
      ...(context.engineSession.warnings?.length
        ? { warnings: [...context.engineSession.warnings] }
        : {}),
      ...(includeTenant && context.metadata.tenantId !== undefined
        ? { tenantId: context.metadata.tenantId }
        : {}),
    };
  }

  listSessions(tenantId?: string): ServiceSessionView[] {
    return this.coordinator
      .inspectAll(tenantId)
      .map(({ context, lease }) => this.sessionView(context, lease, false));
  }

  async closeSession(sessionId: string): Promise<void> {
    this.authority.remove(sessionId);
    try {
      await this.coordinator.close(sessionId);
    } catch (error) {
      throw this.mapError(error);
    } finally {
      this.deleteSessionState(sessionId);
    }
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
   * A3 evidence: export the session's completed spans as a JSON artifact.
   * Spans are already secret-scrubbed by the tracer; the artifact rides
   * the standard store (TTL, size bounds, token-gated serving).
   */
  async exportTrace(sessionId: string): Promise<ArtifactMetadata> {
    this.requireSession(sessionId);
    const spans = (this.tracer?.completedSpans() ?? []).filter(
      (span) => span.attributes.sessionId === sessionId
    );
    const payload = JSON.stringify(
      this.secretManager.redact({ sessionId, exportedAt: new Date().toISOString(), spans }),
      null,
      2
    );
    return this.traced('trace.export', { sessionId }, async () =>
      this.putArtifact(sessionId, 'trace', 'application/json', new TextEncoder().encode(payload), {
        filename: `trace-${sessionId}.json`,
        sessionId,
      })
    );
  }

  /** Shared document source selection and crash recovery for extraction/export. */
  private async readPageSource(
    sessionId: string,
    pageId: string,
    operation: 'extract' | 'exportHtml',
    needsElements = false
  ): Promise<RawPageState> {
    const page = this.requirePage(sessionId, pageId);
    this.coordinator.updateActivity(sessionId);
    try {
      const readDocument = needsElements ? undefined : page.enginePage.readDocument;
      if (readDocument) {
        const document = await readDocument.call(page.enginePage);
        return { ...document, status: 'interactive', elements: [] };
      }
      return await page.enginePage.observe({});
    } catch (error) {
      if (this.isCrash(error)) {
        const errorDetail = this.secretManager.redact(
          error instanceof Error ? error.message : String(error)
        );
        await this.recoverFromCrash(sessionId, `${operation}: engine crashed`, errorDetail);
        throw new ServiceError(
          'ENGINE_CRASHED',
          'The browser engine crashed; the session has been terminated.',
          false,
          { sessionId, errorDetail }
        );
      }
      throw error;
    }
  }

  /**
   * A3 evidence: capture the page's current HTML as an artifact. Raw HTML
   * is NOT secret-scrubbed - typed-in form values ride it verbatim - so
   * the metadata carries an explicit warning, mirroring maskSensitive's
   * honest-refusal precedent.
   */
  async exportHtml(sessionId: string, pageId: string): Promise<ArtifactMetadata> {
    return this.traced('html.export', { sessionId, pageId }, async () => {
      const raw = await this.readPageSource(sessionId, pageId, 'exportHtml');
      const html = raw.content ?? '';
      const metadata = this.putArtifact(
        sessionId,
        'html',
        'text/html; charset=utf-8',
        new TextEncoder().encode(html),
        {
          filename: `page-${pageId}.html`,
          sessionId,
        }
      );
      // byteSize must be the UTF-8 byte length (what contentBase64
      // encodes), not the UTF-16 code-unit count of the JS string - the
      // two diverge on every non-ASCII page.
      const htmlBytes = Buffer.byteLength(html, 'utf8');
      const inline = this.inlineFor(Buffer.from(html, 'utf8').toString('base64'), htmlBytes);
      return {
        ...metadata,
        description:
          'Raw page HTML; NOT secret-redacted - values typed into forms are captured verbatim.',
        ...(inline !== undefined ? { inline } : {}),
      };
    });
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
      // Service-authored diagnostics: thrown as a protocol error so the
      // deliberate message survives (a plain Error would be normalized to
      // withheld INTERNAL prose).
      throw new ServiceError(
        'TARGET_NOT_FOUND',
        `ENGINE_NOT_FOUND: no engine registered as "${name}". Registered: ${registered}`,
        false
      );
    }
    return engine;
  }

  /** Structured, scoped native form filling under the caller’s existing admission. */
  async autofill(sessionId: string, pageId: string, input: unknown) {
    this.requirePage(sessionId, pageId);
    try {
      const report = await runAutofill(input, {
        resolveValue: async (value) => {
          try {
            return this.secretManager.isReference(value)
              ? await this.secretManager.resolve(value)
              : value;
          } catch {
            throw new ServiceError(
              'INVALID_REQUEST',
              'Unable to resolve an autofill value reference'
            );
          }
        },
        redact: (value) => this.secretManager.redact(value),
        assert: () => {
          this.requirePage(sessionId, pageId);
        },
        observe: async () => {
          const view = await this.observe(sessionId, pageId, {
            mode: 'interactive',
            include: ['formControls'],
            maxElements: 2000,
            maxBytes: 1024 * 1024,
          });
          // Compare private normalized values, never non-injective redacted display text.
          const full = this.requirePage(sessionId, pageId).lastObservation;
          return { ...view, elements: full ? [...full.byRef.values()] : [] };
        },
        act: (request, onDispatch) =>
          this.actWithDispatchObserver(sessionId, pageId, request, onDispatch),
        snapshot: async () => {
          const artifact = await this.exportHtml(sessionId, pageId);
          return {
            artifactId: artifact.artifactId,
            contentType: artifact.contentType,
            sizeBytes: artifact.sizeBytes,
            warnings: [
              'Raw HTML is not secret-redacted; receipts carry live field-state evidence.',
            ],
          };
        },
      });
      return this.secretManager.redact(report);
    } catch (error) {
      if (error instanceof Error && !('code' in error))
        throw new ServiceError('INVALID_REQUEST', error.message);
      throw error;
    }
  }

  /**
   * TD-BROWSER-8: execute a batched action plan in one call. Steps run
   * sequentially; a STALE_TARGET failure self-heals once by re-observing and
   * remapping the ref by ordinal (deterministic on stable forms). Once churn
   * crosses into `verified` mode, a remap candidate must also match the
   * pre-failure element's role+label - on a reordering/dynamic page, ordinal
   * position alone can silently land on the wrong element, so under
   * detected churn the executor requires the stronger match or refuses to
   * guess (AMBIGUOUS_REMAP) rather than risk acting on the wrong target. The
   * first hard failure aborts the plan with the completed prefix reported.
   */
  async executePlan(
    sessionId: string,
    pageId: string,
    steps: ServiceActRequest[]
  ): Promise<PlanReport & { mode: 'stable' | 'verified'; newRevision: number }> {
    const results: PlanReport['results'] = [];
    const churnKey = this.churnKey(sessionId, pageId);
    const finalRevision = (): number => this.pages.get(pageId)?.revision ?? 0;
    for (const [index, step] of steps.entries()) {
      // TD-BROWSER-8 Phase 2: pre-step label wait for fields revealed by a
      // prior step. A caller cannot know the ref of an element that does
      // not exist yet at plan-authoring time, so waitForLabel resolves the
      // ref itself - the step's own target is filled in from the wait
      // unless the step already pinned one. A miss surfaces as a typed
      // step failure - never a hang.
      let effectiveStep = step;
      if (step.waitForLabel !== undefined) {
        try {
          const resolvedRef = await this.waitForLabel(
            sessionId,
            pageId,
            step.waitForLabel,
            step.waitMs
          );
          effectiveStep =
            step.target !== undefined ? step : { ...step, target: { ref: resolvedRef } };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({ step: index, ok: false, error: message });
          return {
            ok: false,
            completed: index,
            results,
            mode: this.churnMode(churnKey),
            newRevision: finalRevision(),
            error: { code: 'PLAN_WAIT_TIMEOUT', message },
          };
        }
      }
      if (step.steps !== undefined) {
        // F3: batch envelopes are the /act surface's own shortcut - nesting
        // one inside a plan (or a batch) would double-apply orchestration.
        const message = "'steps' cannot be nested inside a plan step.";
        results.push({ step: index, ok: false, error: message });
        return {
          ok: false,
          completed: index,
          results,
          mode: this.churnMode(churnKey),
          newRevision: finalRevision(),
          error: { code: 'PLAN_STEP_FAILED', message },
        };
      }
      try {
        const effect = (await this.act(sessionId, pageId, effectiveStep)) as ServiceActResult;
        this.decayChurn(churnKey);
        results.push({
          step: index,
          ok: true,
          actionId: effect.actionId,
          ...(effect.remap !== undefined ? { remap: effect.remap } : {}),
          ...(effect.result !== undefined ? { result: effect.result } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const ordinal = /(?:^|e\d+)_(\d+)$/.exec(effectiveStep.target?.ref ?? '')?.[1];
        if (ordinal !== undefined && /STALE_TARGET|revision|fingerprint/i.test(message)) {
          this.bumpChurn(churnKey);
          const mode = this.churnMode(churnKey);
          // The observation the failing ref was minted from, looked up by the
          // ref's own revision prefix: executePlan's self-heal (and any
          // observe-after step) replaces lastObservation mid-plan, so the
          // CURRENT observation no longer holds a ref minted earlier. The
          // per-revision history is where the mint-time element lives; fall
          // back to lastObservation only if that revision was evicted.
          let baseline: PageElement | undefined;
          const page = this.pages.get(pageId);
          if (effectiveStep.target?.ref !== undefined && page) {
            const refRevision = /(?:^|e)(\d+)_/.exec(effectiveStep.target.ref)?.[1];
            baseline =
              (refRevision !== undefined
                ? page.history
                    .get(Number.parseInt(refRevision, 10))
                    ?.byRef.get(effectiveStep.target.ref)
                : undefined) ?? page.lastObservation?.byRef.get(effectiveStep.target.ref);
          }

          const observed = await this.observe(sessionId, pageId, { mode: 'interactive' });
          const elements =
            (
              observed as unknown as {
                elements?: Array<{ ref: string; role?: string; name?: string }>;
              }
            ).elements ?? [];
          this.logger?.debug('plan.remap', {
            ordinal,
            stepRef: effectiveStep.target?.ref,
            count: elements.length,
            mode,
          });

          const candidates = elements.filter(
            (e) => typeof e.ref === 'string' && e.ref.endsWith(`_${ordinal}`)
          );
          let remapped: string | undefined;
          let ambiguous = false;
          if (mode === 'verified') {
            // Candidates arrive redacted (observe() output); the history
            // baseline is not redacted, so compare on the redacted form or
            // an element whose label embeds a secret can never match itself.
            const redactedBaseline = baseline
              ? {
                  role: baseline.role,
                  name: this.secretManager.redact(baseline.name ?? ''),
                }
              : undefined;
            const matches = redactedBaseline
              ? candidates.filter(
                  (e) => e.role === redactedBaseline.role && e.name === redactedBaseline.name
                )
              : [];
            if (matches.length === 1) {
              remapped = matches[0]?.ref;
            } else if (candidates.length > 0) {
              // Candidates exist but none (or several) match: refuse to
              // guess. An empty candidate list is not ambiguity - the
              // element is gone - so that falls through to the honest
              // STALE_TARGET failure below.
              ambiguous = true;
            }
          } else {
            remapped = candidates[0]?.ref;
          }

          if (remapped !== undefined) {
            // The retry can still fail (e.g. a single-use approval token was
            // already burned by the failed attempt, or the step pinned
            // expectedRevision). A failure must surface as the plan
            // envelope, not as a thrown error escaping the catch.
            try {
              const retry = (await this.act(sessionId, pageId, {
                ...effectiveStep,
                target: { ref: remapped },
              })) as ServiceActResult;
              // Fix: the primary success path decays churn (below); the
              // remap-retry success path did not, so a plan of repeated
              // remapped steps never cooled back down out of VERIFIED mode.
              this.decayChurn(churnKey);
              results.push({
                step: index,
                ok: true,
                actionId: retry.actionId,
                ...(retry.remap !== undefined ? { remap: retry.remap } : {}),
                ...(retry.result !== undefined ? { result: retry.result } : {}),
              });
              continue;
            } catch (retryError) {
              const retryMessage =
                retryError instanceof Error ? retryError.message : String(retryError);
              results.push({ step: index, ok: false, error: retryMessage });
              return {
                ok: false,
                completed: index,
                results,
                mode: this.churnMode(churnKey),
                newRevision: finalRevision(),
                error: { code: 'PLAN_STEP_FAILED', message: retryMessage },
              };
            }
          }
          if (ambiguous) {
            const ambiguousMessage = `AMBIGUOUS_REMAP: ${candidates.length} candidate(s) at ordinal ${ordinal} but none matched the pre-failure role/label; refusing to guess under high churn.`;
            results.push({ step: index, ok: false, error: ambiguousMessage });
            return {
              ok: false,
              completed: index,
              results,
              mode,
              newRevision: finalRevision(),
              error: { code: 'AMBIGUOUS_REMAP', message: ambiguousMessage },
            };
          }
        }
        results.push({ step: index, ok: false, error: message });
        return {
          ok: false,
          completed: index,
          results,
          mode: this.churnMode(churnKey),
          newRevision: finalRevision(),
          error: { code: 'PLAN_STEP_FAILED', message },
        };
      }
    }
    return {
      ok: true,
      completed: steps.length,
      results,
      mode: this.churnMode(churnKey),
      newRevision: finalRevision(),
    };
  }

  /** Execute one plan and verify its outcome from a trusted read-only evidence source. */
  async executeOutcome(
    sessionId: string,
    pageId: string,
    input: unknown
  ): Promise<OutcomeRunReport> {
    let request: OutcomeRunRequest;
    try {
      request = parseOutcomeRunRequest(input);
    } catch {
      throw new ServiceError('INVALID_REQUEST', 'Invalid outcome run request.');
    }
    const parseReport = createOutcomeRunReportParser(request);
    const session = this.requireSession(sessionId);
    this.requirePage(sessionId, pageId);
    if (!this.verifierRegistry || !this.evidenceSourceRegistry) {
      throw new ServiceError('INVALID_REQUEST', 'Outcome verification is not configured.');
    }
    try {
      // Resolve the verifier before any action can be dispatched so unsupported
      // verifier identities are request failures, not ambiguous execution failures.
      this.verifierRegistry.describe(
        request.verification.verifier.id,
        request.verification.verifier.version
      );
    } catch {
      throw new ServiceError('INVALID_REQUEST', 'Unknown outcome verifier.');
    }

    const controlled = this.controlledContexts.has(session);
    const run = await runVerifiedOutcome({
      verifierRegistry: this.verifierRegistry,
      evidenceSources: this.evidenceSourceRegistry,
      verifier: { ...request.verification.verifier, input: request.verification.input },
      ...(request.verification.evidenceCorrelationId !== undefined
        ? { evidenceCorrelationId: request.verification.evidenceCorrelationId }
        : {}),
      context: {
        sessionId,
        pageId,
        ...(session.metadata.tenantId !== undefined ? { tenantId: session.metadata.tenantId } : {}),
        signal: session.signal,
      },
      execute: () =>
        this.executePlan(sessionId, pageId, request.actions as unknown as ServiceActRequest[]),
      executionFailed: (plan) => !plan.ok,
      assertAuthority: () => {
        this.requirePage(sessionId, pageId);
      },
      didDispatch: controlled
        ? () => this.authority.didDispatchInScope(sessionId)
        : () => request.actions.length > 0,
      testedSeam: 'ui',
      signal: session.signal,
    });

    const plan: PlanReport = run.result ?? {
      ok: false,
      completed: 0,
      results: [],
      error:
        run.outcome.execution === 'not_started'
          ? { code: 'OUTCOME_NOT_EXECUTED', message: 'The outcome plan was not executed.' }
          : {
              code: 'OUTCOME_REPORT_UNAVAILABLE',
              message: 'The plan result is unavailable; dispatched effects may be unknown.',
            },
    };
    try {
      const report = parseReport({ plan, outcome: run.outcome });
      return parseReport(this.secretManager.redact(report));
    } catch {
      throw new ServiceError('INTERNAL', 'Invalid internal outcome report.');
    }
  }

  /**
   * Capture one physical page owner with separate execution and publication checks.
   * Internal only: publication conveys no engine read or dispatch authority.
   */
  private capturePageOwnerInScope(sessionId: string, pageId: string) {
    const session = this.requireSession(sessionId);
    const page = this.requirePage(sessionId, pageId);
    const enginePage = page.enginePage;
    const guard = this.authority.outputGuard(sessionId);
    const admission = this.authority.admissionInScope(sessionId);
    const sessionIncarnation = this.authority.sessionIncarnation(sessionId);
    const ownerSignal = this.authority.signal(sessionId);
    const publicationGuard = this.authority.publicationGuardInScope(sessionId);
    let revoked: unknown;
    let ownerRevoked: unknown;
    const assertPinned = () => {
      if (ownerRevoked !== undefined) throw ownerRevoked;
      try {
        if (
          this.authority.sessionIncarnation(sessionId) !== sessionIncarnation ||
          this.coordinator.get(sessionId) !== session ||
          this.pages.get(pageId) !== page ||
          page.sessionId !== sessionId ||
          page.enginePage !== enginePage ||
          ownerSignal.aborted
        )
          throw new ServiceError('CONTROL_REVOKED', 'Native form read owner changed.');
      } catch (error) {
        ownerRevoked = error;
        throw error;
      }
    };
    const assertOwner = () => {
      if (revoked !== undefined) throw revoked;
      try {
        guard();
        if (this.authority.admissionInScope(sessionId) !== admission)
          throw new ServiceError('CONTROL_REVOKED', 'Native form read admission changed.');
        assertPinned();
      } catch (error) {
        revoked = error;
        throw error;
      }
    };
    let publicationRevoked = false;
    const publication = Object.freeze({
      assertCurrent: () => {
        if (publicationRevoked)
          throw new ServiceError('CONTROL_REVOKED', 'Page publication revoked.');
        try {
          publicationGuard();
          assertPinned();
        } catch (error) {
          publicationRevoked = true;
          throw error;
        }
      },
    });
    assertOwner();
    return Object.freeze({
      identity: Object.freeze({ sessionId, pageId, sessionIncarnation }),
      enginePage,
      ownerSignal,
      assertAuthority: assertOwner,
      publication,
    });
  }

  prepareNativeFormReadInScope(sessionId: string, pageId: string): PreparedNativeFormRead {
    const owner = this.capturePageOwnerInScope(sessionId, pageId);
    const { enginePage, ownerSignal, assertAuthority: assertOwner } = owner;
    const assertRead = (signal?: AbortSignal) => {
      assertOwner();
      if (signal?.aborted)
        throw new ServiceError('CONTROL_REVOKED', 'Native form read was cancelled.');
    };

    let capture: EnginePage['captureNativeForm'];
    try {
      capture = enginePage.captureNativeForm;
    } catch {
      assertOwner();
      throw new ServiceError('ENGINE_UNSUPPORTED', 'Native form evidence capture is unavailable.');
    }
    assertOwner();
    if (typeof capture !== 'function')
      throw new ServiceError('ENGINE_UNSUPPORTED', 'Native form evidence capture is unavailable.');
    const captureNativeForm = capture;
    return Object.freeze({
      identity: owner.identity,
      assertAuthority: () => assertOwner(),
      publication: owner.publication,
      read: async (signal?: AbortSignal) => {
        assertRead(signal);
        const combinedSignal = signal ? AbortSignal.any([ownerSignal, signal]) : ownerSignal;
        return await this.authority.trackReadInScope(sessionId, async () => {
          assertRead(signal);
          let captured: unknown;
          try {
            captured = await Reflect.apply(captureNativeForm, enginePage, [
              { signal: combinedSignal },
            ]);
          } catch {
            assertOwner();
            if (signal?.aborted)
              throw new ServiceError('CONTROL_REVOKED', 'Native form read was cancelled.');
            throw new ServiceError('ENGINE_UNSUPPORTED', 'Native form evidence capture failed.');
          }
          assertRead(signal);
          let detached: NativeFormEvidence;
          try {
            detached = parseNativeFormEvidence(captured);
          } catch {
            assertOwner();
            if (signal?.aborted)
              throw new ServiceError('CONTROL_REVOKED', 'Native form read was cancelled.');
            throw new ServiceError(
              'ENGINE_UNSUPPORTED',
              'Native form evidence capture returned invalid data.'
            );
          }
          assertRead(signal);
          return detached;
        });
      },
    });
  }

  /** Internal native-form qualification; consuming this review never dispatches an action. */
  prepareEvidenceReviewInScope(
    sessionId: string,
    pageId: string,
    options: { action: Record<string, unknown>; source: EvidenceReviewSource }
  ): PreparedEvidenceReview {
    return this.prepareBoundEvidenceReview(sessionId, pageId, options);
  }

  /** Internal C3b composition only; public review creation remains a separate gate. */
  prepareApplicationSubmissionReviewInScope(
    sessionId: string,
    pageId: string,
    request: ApplicationRequest,
    source: EvidenceReviewSource
  ): PreparedEvidenceReview {
    const review = this.applicationAuthority.prepareOperationReviewInScope(sessionId, request);
    return this.prepareBoundEvidenceReview(
      sessionId,
      pageId,
      { action: review.action, source },
      review
    );
  }

  private prepareBoundEvidenceReview(
    sessionId: string,
    pageId: string,
    options: { action: Readonly<Record<string, unknown>>; source: EvidenceReviewSource },
    application?: PreparedApplicationOperationReview,
    capturedPage?: PreparedNativeFormRead
  ): PreparedEvidenceReview {
    try {
      const context = this.reviewContext(sessionId);
      const contextKey = canonicalJson(context);
      const action = JSON.parse(
        canonicalJson(snapshotJsonData(options.action, VERIFICATION_SNAPSHOT_LIMITS))
      ) as Record<string, unknown>;
      // Reuse the existing page/admission owner, without performing another native read.
      const page = capturedPage ?? this.prepareNativeFormReadInScope(sessionId, pageId);
      const publication = this.authority.captureReviewPublicationInScope(sessionId);
      const assertAuthority = () => {
        application?.assertCurrent();
        page.assertAuthority();
        if (canonicalJson(this.reviewContext(sessionId)) !== contextKey)
          throw new ServiceError('CONTROL_REVOKED', 'Review authority changed.');
      };
      return prepareEvidenceReview({
        gate: this.approvalGate,
        context,
        pageId,
        action,
        source: options.source,
        assertAuthority,
        publication: {
          assertCurrent: () => {
            application?.publication.assertCurrent();
            page.publication.assertCurrent();
            publication.assertCurrent();
          },
          assertPinned: () => {
            application?.publication.assertPinned();
            page.publication.assertCurrent();
            publication.assertCurrent();
          },
        },
        assertDisclosureSafe: (value) => this.assertReviewDisclosureSafe(value),
        trackRead: (read) => this.authority.trackReadInScope(sessionId, read),
        lifecycleSignal: this.authority.signal(sessionId),
      });
    } catch {
      throw new ServiceError('INVALID_REQUEST', 'Evidence review unavailable');
    }
  }

  private prepareApplicationConsent(
    review: PreparedApplicationOperationReview,
    tokenId: string
  ): PreparedApplicationConsent {
    const sessionId = review.sessionId;
    const context = this.reviewContext(sessionId);
    const signal = this.authority.signal(sessionId);
    let prepared: PreparedEvidenceReview | undefined;
    let assertPinned: (() => void) | undefined;
    let attempted = false;
    let consumed = false;
    return Object.freeze({
      consume: async () => {
        if (attempted) throw new ServiceError('CONTROL_REQUIRED', 'Submission consent unavailable');
        attempted = true;
        review.assertCurrent();
        const resolved = await this.resolveApproval(sessionId, tokenId, review);
        this.assertReviewContext(sessionId, context);
        review.assertCurrent();
        if (!resolved.prepared || !resolved.assertPinned)
          throw new ServiceError('CONTROL_REQUIRED', 'Submission consent unavailable');
        prepared = resolved.prepared;
        assertPinned = resolved.assertPinned;
        const result = await prepared.consume(tokenId, signal);
        this.assertReviewContext(sessionId, context);
        review.assertCurrent();
        consumed = result === true;
        return consumed;
      },
      assertCurrent: () => {
        if (!consumed || !prepared || !assertPinned)
          throw new ServiceError('CONTROL_REQUIRED', 'Submission consent unavailable');
        this.assertReviewContext(sessionId, context);
        review.assertCurrent();
        prepared.assertCurrent(signal);
        assertPinned();
        this.assertReviewContext(sessionId, context);
      },
    });
  }

  // ------------------------------------------------------------------
  // Application surface (shared-infra slice 2): thin wrappers around the
  // composed ApplicationAuthority. Every method demands a principal from
  // the surface; the authority itself enforces tenant match, binding
  // state and (for writes) operation identity + business version.
  // ------------------------------------------------------------------

  /** Operator-only: bind an application adapter to a resource while the human owns the session. */
  applicationBind(
    sessionId: string,
    principal: SessionPrincipal,
    input: unknown
  ): { adapter: string; resource: string } {
    const validated = validateApplicationBinding(input);
    if (!validated.ok) {
      throw new ServiceError(
        'INVALID_REQUEST',
        `Invalid application bind request: ${validated.issues
          .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
          .join('; ')}`
      );
    }
    this.applicationAuthority.bind(sessionId, principal, validated.value);
    return { adapter: validated.value.adapter, resource: validated.value.resource };
  }

  /**
   * Operator-only: drop the binding. Like bind, this requires the human to
   * own the session and takes control as a side effect (epoch bump, any
   * prepared review invalidated) even when nothing is bound.
   */
  applicationUnbind(sessionId: string, principal: SessionPrincipal): { unbound: true } {
    this.applicationAuthority.unbind(sessionId, principal);
    return { unbound: true };
  }

  /** Discovery: the bound adapter's operations, or null when nothing is bound. */
  async applicationDiscover(
    sessionId: string,
    principal: SessionPrincipal,
    publication?: Parameters<ApplicationAuthority['discover']>[2]
  ): Promise<Awaited<ReturnType<ApplicationAuthority['discover']>>> {
    return this.applicationAuthority.discover(sessionId, principal, publication);
  }

  /** Allocate one pending review; no execution identity is reserved or dispatched. */
  async applicationReview(
    sessionId: string,
    principal: SessionPrincipal,
    input: unknown,
    publicationOptions?: SessionPublication<OperatorApprovalView>
  ): Promise<OperatorApprovalView> {
    const publication =
      publicationOptions === undefined ? undefined : snapshotPublication(publicationOptions);
    let disclosure: PreparedReviewDisclosure | undefined;
    if (principal.actor !== 'operator')
      throw new ServiceError('FORBIDDEN', 'Operator authority is required');
    const validated = validateApplicationReview(input);
    if (!validated.ok)
      throw new ServiceError('INVALID_REQUEST', 'Invalid application review request');
    const result = await this.authority.run(
      sessionId,
      principal,
      {},
      async () => {
        disclosure = await this.prepareApplicationReviewInScope(sessionId, validated.value);
        return disclosure.view;
      },
      undefined,
      publication
        ? {
            ...publication,
            publish: async (value, context) => {
              if (!disclosure)
                throw new ServiceError('CONTROL_REVOKED', 'Review publication unavailable');
              const output = composePublicationContext(context, disclosure.assertCurrent);
              output.assertCurrent();
              await publication.publish(value, output);
              output.assertCurrent();
            },
          }
        : undefined
    );
    if ('replay' in result) throw new ServiceError('INTERNAL', 'Application review unavailable');
    return result;
  }

  /** Internal inert disclosure for an already admitted review; no transport or new ticket. */
  async prepareApplicationReviewInScope(
    sessionId: string,
    input: unknown
  ): Promise<PreparedReviewDisclosure> {
    const validated = validateApplicationReview(input);
    if (!validated.ok)
      throw new ServiceError('INVALID_REQUEST', 'Invalid application review request');
    const body = validated.value;
    const context = this.reviewContext(sessionId);
    const originalPage = this.prepareNativeFormReadInScope(sessionId, body.pageId);
    const intent = this.applicationAuthority.prepareOperationReviewInScope(sessionId, body.request);
    intent.assertCurrent();
    originalPage.assertAuthority();
    this.assertReviewContext(sessionId, context);
    const application = selectApplicationReview(intent.action);
    if (!application) throw new ServiceError('INVALID_REQUEST', 'Application review unavailable');
    const { prepared, assertPinned, assertOwners } = this.prepareConfiguredEvidenceReview(
      sessionId,
      context,
      { pageId: body.pageId, source: body.source, application },
      intent,
      originalPage
    );
    const view = await prepared.generate(this.authority.signal(sessionId));
    assertPinned();
    const disclosure = prepared.capturePublication(view);
    // Finish with captured-owner comparisons after all source/application callbacks.
    assertOwners();
    this.assertReviewDisclosureSafe(disclosure.view);
    assertOwners();
    return disclosure;
  }

  /** Dispatch one application operation. Writes require operation ID + expected version. */
  async applicationExecute(
    sessionId: string,
    principal: SessionPrincipal,
    input: unknown,
    publication?: Parameters<ApplicationAuthority['execute']>[3],
    replay?: OperationPublication
  ): Promise<Awaited<ReturnType<ApplicationAuthority['execute']>>> {
    const validated = validateApplicationExecute(input);
    if (!validated.ok) {
      throw new ServiceError(
        'INVALID_REQUEST',
        `Invalid application execute request: ${validated.issues
          .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
          .join('; ')}`
      );
    }
    return this.applicationAuthority.execute(
      sessionId,
      principal,
      validated.value,
      publication,
      replay
    );
  }

  /** Read one application receipt by its operation ID. */
  async applicationReceipt(
    sessionId: string,
    principal: SessionPrincipal,
    operationId: string,
    publication?: SessionPublication<unknown>
  ): Promise<unknown> {
    return this.applicationAuthority.lookupReceipt(sessionId, principal, operationId, publication);
  }

  /**
   * TD-BROWSER-8 Phase 2: poll until an element whose name contains
   * `label` appears, then return ITS resolved (service-level) ref - a
   * caller cannot supply a ref for an element that does not exist yet at
   * plan-authoring time. Ticks use RAW engine observations, not
   * this.observe() - a full observe() per tick would replace
   * lastObservation and consume one of the bounded history slots, evicting
   * the mint-revision baseline verified-mode remap depends on. Only the
   * final hit runs a real observe(), which also mints the actionable ref.
   */
  private async waitForLabel(
    sessionId: string,
    pageId: string,
    label: string,
    waitMs?: number
  ): Promise<string> {
    const page = this.requirePage(sessionId, pageId);
    // waitMs arrives from the public plan route unvalidated (the plan body
    // is a loose array until PlanStepSchema lands). A non-number ("abc")
    // or non-finite (1e308 -> Infinity deadline) value used to poison the
    // deadline arithmetic - `Date.now() >= NaN` is always false, so the
    // poll loop below never exited (unbounded observe churn, forever).
    // Validate hard: reject garbage, bound the sane range, default 5000.
    if (
      waitMs !== undefined &&
      (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs < 100 || waitMs > 60_000)
    ) {
      throw new ServiceError(
        'INVALID_REQUEST',
        `waitMs must be a finite number between 100 and 60000; got ${JSON.stringify(waitMs)}`,
        false
      );
    }
    const boundedWaitMs = waitMs ?? 5000;
    const deadline = Date.now() + boundedWaitMs;
    for (;;) {
      const raw = await page.enginePage.observe({});
      const hit = raw.elements.some(
        (element) => typeof element.name === 'string' && element.name.includes(label)
      );
      if (hit) {
        const observed = (await this.observe(sessionId, pageId, {
          mode: 'interactive',
        })) as unknown as { elements: Array<{ ref: string; name?: string }> };
        const resolved = observed.elements.find(
          (element) => typeof element.name === 'string' && element.name.includes(label)
        );
        if (resolved === undefined) {
          // Present in the raw tick but not in the redacted/normalized
          // observation - it exists but under interactive-mode filtering
          // it doesn't qualify as actionable. Treat as a miss.
          if (Date.now() >= deadline) {
            throw new ServiceError(
              'ACTION_TIMEOUT',
              `waitForLabel: '${label}' matched a raw element but never became actionable within ${boundedWaitMs}ms`,
              true
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        return resolved.ref;
      }
      if (Date.now() >= deadline) {
        throw new ServiceError(
          'ACTION_TIMEOUT',
          `waitForLabel: no element matching '${label}' appeared within ${boundedWaitMs}ms`,
          true
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private churn = new Map<string, number>();
  private churnKey(sessionId: string, pageId: string): string {
    return `${sessionId}:${pageId}`;
  }
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
    pageId: string,
    bounds?: { maxElements?: number; maxBytes?: number }
  ): Promise<{
    url: string;
    title: string;
    revision: number;
    mode: 'stable' | 'verified';
    fields: Array<{ ref: string; role: string; label: string }>;
    truncated?: boolean;
    degraded?: boolean;
    degradedReason?:
      | 'aria-snapshot-timeout'
      | 'dom-semantic-subset'
      | 'empty-snapshot-nonempty-dom';
  }> {
    // Payload economics (TD-BROWSER-8 pressure matrix, row 4): the fields
    // list previously had no way to bound its size from the caller's side;
    // it now flows through the same byte/element budget as observe().
    const state = await this.observe(sessionId, pageId, {
      mode: 'interactive',
      ...(bounds?.maxElements !== undefined ? { maxElements: bounds.maxElements } : {}),
      ...(bounds?.maxBytes !== undefined ? { maxBytes: bounds.maxBytes } : {}),
    });
    const view = state as unknown as {
      url?: string;
      title?: string;
      revision?: number;
      elements?: Array<{ ref: string; role?: string; name?: string }>;
      truncated?: boolean;
      degraded?: boolean;
      degradedReason?:
        | 'aria-snapshot-timeout'
        | 'dom-semantic-subset'
        | 'empty-snapshot-nonempty-dom';
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
      ...(view.truncated === true ? { truncated: true } : {}),
      // Whole-body ariaSnapshot fallback signal (see observe()): a
      // one-shot-plan caller must see this just as clearly as browser_observe
      // does, since `fields` alone looks structurally identical either way.
      ...(view.degraded === true ? { degraded: true } : {}),
      ...(view.degradedReason !== undefined ? { degradedReason: view.degradedReason } : {}),
    };
  }

  // ---- pages --------------------------------------------------------------

  async createPage(sessionId: string, request?: { url?: string }): Promise<ServicePageView> {
    const session = this.requireSession(sessionId);
    this.coordinator.updateActivity(sessionId);

    // Validate a requested url before the page exists so a bad request
    // creates nothing; navigate() below remains the enforcing path for
    // egress policy once the page is live.
    if (request?.url !== undefined) {
      if (typeof request.url !== 'string') {
        throw new ServiceError('INVALID_REQUEST', 'url must be a string', false);
      }
      let parsed: URL;
      try {
        parsed = new URL(request.url);
      } catch {
        throw new ServiceError(
          'INVALID_REQUEST',
          `Invalid URL: ${request.url.slice(0, 100)}`,
          false
        );
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ServiceError(
          'POLICY_DENIED',
          `Navigation accepts http(s) URLs only; '${parsed.protocol}' is not permitted.`,
          false,
          { url: redactUrl(request.url) }
        );
      }
    }

    const create = () => session.engineSession.newPage();
    const rawPage = await (this.controlledContexts.has(session)
      ? this.authority.dispatchInScope(sessionId, create)
      : create());
    if (session.signal.aborted) {
      await rawPage.close().catch(() => {});
      throw new ServiceError('SESSION_NOT_FOUND', 'Session ended during page creation');
    }
    const enginePage = this.guardPage(sessionId, rawPage);
    const pageId = `pg_${++this.pageCounter}_${enginePage.id}`;
    this.pages.set(pageId, { sessionId, enginePage, revision: 1, history: new Map() });

    // Stream engine events to session subscribers until the page closes.
    this.pumpEvents(sessionId, pageId, enginePage);

    // A page-less session contract is easy to miss (TD-BROWSER-11): when
    // the caller asks for a url at creation, land the page on it instead
    // of silently ignoring the field.
    if (request?.url !== undefined) {
      try {
        await this.navigate(sessionId, pageId, { url: request.url });
      } catch (error) {
        if (this.authority.get(sessionId)?.view().state === 'PAUSE_REQUESTED') throw error;
        // Runtime navigate failures (DNS, refused, egress policy) happen
        // after registration; leaving the page in would surface a live
        // about:blank page the caller believes was never created. Mirror
        // closePage's teardown and rethrow the navigate error.
        try {
          await enginePage.close();
        } catch {
          // An engine that refuses the close must not mask the navigate error.
        }
        this.pages.delete(pageId);
        this.churn.delete(this.churnKey(sessionId, pageId));
        throw error;
      }
    }

    return { pageId, sessionId, status: 'ready' };
  }

  async getPage(sessionId: string, pageId: string): Promise<ServicePageView | undefined> {
    const page = this.pages.get(pageId);
    if (!page || page.sessionId !== sessionId) {
      return undefined;
    }
    const cachedUrl = page.enginePage.getCachedUrl?.();
    const url = typeof cachedUrl === 'string' ? this.secretManager.redact(cachedUrl) : undefined;
    const title = await page.enginePage.getTitle?.().catch(() => undefined);
    return {
      pageId,
      sessionId,
      status: 'active',
      ...(url !== undefined ? { url } : {}),
      ...(title !== undefined ? { title: this.secretManager.redact(title) } : {}),
      ...(page.openerPageId !== undefined ? { openerPageId: page.openerPageId } : {}),
    };
  }

  /**
   * Pages of a session in creation order. Pages exist only once created
   * through the create-page endpoint; this listing is the discovery path
   * when that response was lost and the answer to "which page ids are
   * live here". `url` uses only the engine's optional synchronous cache;
   * discovery never queues browser I/O or waits for a live URL lookup.
   */
  async listPages(sessionId: string): Promise<ServicePageView[]> {
    this.requireSession(sessionId);
    const result: ServicePageView[] = [];
    for (const [pageId, page] of this.pages) {
      if (page.sessionId !== sessionId) continue;
      let url: string | undefined;
      try {
        const cached = page.enginePage.getCachedUrl?.();
        url = typeof cached === 'string' ? cached : undefined;
      } catch {
        // Optional metadata must not prevent discovery of a live page ID.
      }
      result.push(
        this.secretManager.redact({
          pageId,
          sessionId,
          status: 'active',
          ...(url !== undefined ? { url } : {}),
          ...(page.openerPageId !== undefined ? { openerPageId: page.openerPageId } : {}),
        })
      );
    }
    return result;
  }

  async closePage(sessionId: string, pageId: string): Promise<void> {
    const page = this.requirePage(sessionId, pageId);
    this.coordinator.updateActivity(sessionId);

    await page.enginePage.close();
    this.pages.delete(pageId);
    this.churn.delete(this.churnKey(sessionId, pageId));
  }

  // ---- navigation ---------------------------------------------------------

  async navigate(
    sessionId: string,
    pageId: string,
    request: { url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | undefined }
  ): Promise<import('@agentbrowser/engine').NavigationResult> {
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
          { url: redactUrl(url), reason: 'egress_policy' }
        );
      }

      const hostname = this.hostnameOf(url);
      const policySpan = this.tracer?.startSpan(
        'policy.check',
        this.secretManager.redact({ hostname }),
        span
      );
      try {
        const policy = this.sessionPolicies.get(sessionId);
        if (!policy) throw new ServiceError('SESSION_NOT_FOUND', 'Session policy is unavailable');
        await policy.checkRequest({ hostname, url });
        if (policySpan) {
          this.tracer?.endSpan(policySpan, { allowed: true });
        }
      } catch (error) {
        if (policySpan) {
          this.tracer?.failSpan(
            policySpan,
            'POLICY_DENIED',
            this.secretManager.redact(error instanceof Error ? error.message : String(error))
          );
          this.tracer?.endSpan(policySpan);
        }
        throw this.mapError(error);
      }

      // Dispatch invalidates public refs even if navigation commits an error
      // document or rejects. Preflight policy refusal above leaves refs intact.
      page.revision += 1;
      page.lastObservation = undefined;
      let result: Awaited<ReturnType<EnginePage['navigate']>>;
      try {
        result = await page.enginePage.navigate({
          url,
          ...(request.waitUntil !== undefined ? { waitUntil: request.waitUntil } : {}),
        });
      } catch (error) {
        const failure = normalizeNavigationFailure(error);
        if (failure.code === 'ENGINE_CRASHED') {
          const errorDetail = this.secretManager.redact(
            error instanceof Error ? error.message : String(error)
          );
          await this.recoverFromCrash(sessionId, 'navigate: engine crashed', errorDetail);
          throw new ServiceError(
            'ENGINE_CRASHED',
            'The browser engine closed; the session has been terminated.',
            false,
            { reason: 'engine_error' }
          );
        }
        throw new ServiceError(failure.code, failure.message, failure.retryable, failure.details);
      }

      return this.secretManager.redact({
        status: result.status,
        url: result.url,
        redirectChain: result.redirectChain,
        ...(result.status !== 'success'
          ? { reason: isNavigationFailureReason(result.reason) ? result.reason : 'engine_error' }
          : {}),
      });
    });
  }

  // ---- observation --------------------------------------------------------

  async observe(
    sessionId: string,
    pageId: string,
    request: PartialObservation
  ): Promise<PageState> {
    const checked = validateObservationRequest(request);
    if (!checked.ok)
      throw new ServiceError(
        'INVALID_REQUEST',
        checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
        false,
        { issues: checked.issues, validIncludes: [...DELIVERED_INCLUDES].sort() }
      );
    const page = this.requirePage(sessionId, pageId);
    this.coordinator.updateActivity(sessionId);

    // Capture schemas validate delivered modes and enrichments before any browser work.
    // Normalize the full element list; pagination and diffing are service concerns.
    // Optional readiness wait (SPA hydration): run the same wait machinery as
    // browser_act BEFORE snapshotting, so a slow-mounting page does not observe
    // as empty. Omitting `wait` keeps the fast default path unchanged.
    if (request.wait !== undefined) {
      await this.waitFor(page.enginePage, request.wait);
    }
    const observationRequest: ObservationRequest = {
      ...(checked.value.mode !== undefined ? { mode: checked.value.mode } : {}),
      ...(checked.value.include !== undefined ? { include: checked.value.include } : {}),
    };
    let raw: Awaited<ReturnType<EnginePage['observe']>>;
    try {
      raw = await page.enginePage.observe(observationRequest);
    } catch (error) {
      if (this.isCrash(error)) {
        const errorDetail = this.secretManager.redact(
          error instanceof Error ? error.message : String(error)
        );
        await this.recoverFromCrash(sessionId, 'observe: engine crashed', errorDetail);
        throw new ServiceError(
          'ENGINE_CRASHED',
          'The browser engine crashed; the session has been terminated.',
          false,
          { sessionId, errorDetail }
        );
      }
      throw error;
    }

    if (
      raw.revision !== undefined &&
      page.lastObservation?.engineRevision !== undefined &&
      raw.revision !== page.lastObservation.engineRevision &&
      page.revision === page.lastObservation.revision
    ) {
      page.revision += 1;
    }
    const observation = this.normalizer.normalize(raw, {
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
      retainAllElements: true,
      revision: page.revision,
      sessionId,
      pageId,
    });

    // Bridge normalized refs back to engine refs so actions can resolve them.
    const refMap = new Map<string, string>();
    const byRef = new Map<string, PageElement>();
    const byEngineRef = new Map<string, PageElement>();
    for (const element of observation.elements) {
      byRef.set(element.ref, element);
      const ordinal = parseRef(element.ref)?.ordinal;
      const engineRef = ordinal !== undefined ? raw.elements[ordinal]?.ref : undefined;
      if (engineRef !== undefined) {
        refMap.set(element.ref, engineRef);
        byEngineRef.set(engineRef, element);
      }
    }
    page.lastObservation = {
      revision: page.revision,
      url: raw.url,
      ...(raw.revision !== undefined ? { engineRevision: raw.revision } : {}),
      refMap,
      byRef,
    };

    // Retain the snapshot for sinceRevision diffs (bounded history).
    page.history.set(page.revision, { byRef, byEngineRef });
    while (page.history.size > HISTORY_LIMIT) {
      const oldest = page.history.keys().next().value;
      if (oldest !== undefined) {
        page.history.delete(oldest);
      }
    }

    if (request.sinceRevision !== undefined) {
      // The diff path accepts maxBytes but previously returned unbounded;
      // paginateObservation applies the same byte budget to the diff result.
      return this.paginateObservation(
        this.diffObservation(page, observation, request.sinceRevision),
        request
      );
    }

    return this.paginateObservation(observation, request);
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

    const snapshot = page.history.get(current.revision);
    if (snapshot === undefined) {
      throw new ServiceError(
        'INTERNAL',
        `Missing retained observation at revision ${current.revision}.`
      );
    }
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
      for (const field of ['role', 'name', 'value', 'visible', 'enabled', 'checked'] as const) {
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
    try {
      return budgetObservation(this.secretManager.redact(observation), {
        maxBytes: request.maxBytes,
        maxElements: request.maxElements,
        continueFrom: request.continueFrom,
      });
    } catch (error) {
      const detail = normalizeEngineError(error);
      throw new ServiceError(detail.code, detail.message, detail.retryable, detail.details);
    }
  }

  // ---- actions ------------------------------------------------------------

  async act(
    sessionId: string,
    pageId: string,
    request: ServiceActRequest
  ): Promise<ServiceActResult | ServiceBatchActResult> {
    return this.actWithDispatchObserver(sessionId, pageId, request);
  }

  /** Internal single-action seam used by orchestration to observe real dispatch. */
  private async actWithDispatchObserver(
    sessionId: string,
    pageId: string,
    input: ServiceActRequest,
    onDispatch?: () => void
  ): Promise<ServiceActResult | ServiceBatchActResult> {
    // Reviewed consent and dispatch must share one detached request across all
    // awaits, including nested target/values/paths. Legacy input semantics stay intact.
    let request = input;
    if (this.sessionApprovalPolicies.get(sessionId)?.review === 'operator') {
      try {
        request = JSON.parse(canonicalJson(input)) as ServiceActRequest;
      } catch {
        throw new ServiceError('INVALID_REQUEST', 'Reviewed actions require bounded JSON data');
      }
    }
    return this.traced('act', { sessionId, pageId, action: request.action }, async (span) => {
      const page = this.requirePage(sessionId, pageId);
      this.coordinator.updateActivity(sessionId);

      // F3: the batch envelope dispatches before any single-action work -
      // a batch body has no `action`, and the single-action gates below
      // would misread it.
      if (request.steps !== undefined) {
        return await this.executeActBatch(sessionId, pageId, request);
      }

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
              ? new ServiceError('INVALID_REQUEST', secretError.message ?? 'secret error', false, {
                  reason: secretError.code,
                })
              : new ServiceError('INTERNAL', String(error))
          );
        }
      }

      // Wait validation (spec 11.1): unknown conditions are rejected before
      // anything runs; every wait carries a deadline. F6/F7: the new
      // conditions are checked for their required field pairing too.
      const DELIVERED_WAITS = new Set<string>(DELIVERED_WAIT_TYPES);
      if (request.wait !== undefined) {
        this.validateWaitCondition(request.wait, DELIVERED_WAITS);
      }
      // The wait ACTION shares the delivered condition set (schema checks
      // the shape; this checks the semantics).
      if (request.condition !== undefined) {
        this.validateWaitCondition(request.condition, DELIVERED_WAITS);
      }

      // ADR-015 B4b: construct-then-validate. The wire body is flat, so
      // validation happens on the constructed protocol action - one gate
      // for REST /act, /plan (which loops through this method), and direct
      // service callers. Structural failures (missing target, bad param
      // shape) are schema-driven for every delivered action.
      const actionValidation = decodeWireAction(actRequest);
      if (!actionValidation.ok) {
        const details = actionValidation.issues
          .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
          .join('; ');
        throw new ServiceError('INVALID_REQUEST', `Invalid action: ${details}`, false, {
          issues: actionValidation.issues,
        });
      }

      const adapter = new RefTranslatingPage(page.enginePage, page);
      const result = await this.executor.execute(
        {
          pageId,
          expectedRevision: actRequest.expectedRevision ?? page.revision,
          action: actionValidation.value,
        },
        {
          enginePage: adapter,
          observation: this.lastObservationOf(page),
          currentRevision: page.revision,
          beforeAction: async (resolved) => {
            await this.checkApproval(sessionId, pageId, page, request, resolved?.fingerprint, span);
            onDispatch?.();
          },
          // TD-BROWSER-9, A7: reuse the map already built in observe() rather
          // than let the executor re-scan observation.elements per action.
          ...(page.lastObservation !== undefined
            ? { elementIndex: page.lastObservation.byRef }
            : {}),
        }
      );

      if (result.error) {
        // A crash inside the executor surfaces as an INTERNAL whose message
        // names the crash; recover before rethrowing the typed error.
        if (result.error.code === 'ENGINE_CRASHED') {
          const errorDetail = this.secretManager.redact(result.error.message);
          await this.recoverFromCrash(sessionId, 'act: engine crashed', errorDetail);
          throw this.redactedError(
            new ServiceError(
              'ENGINE_CRASHED',
              'The browser engine crashed; the session has been terminated.',
              false,
              { sessionId, errorDetail }
            )
          );
        }
        if (result.error.code === 'ACTION_TIMEOUT') {
          // One-round-trip diagnostics (F4): the page state at timeout is
          // evidence the client cannot recover later. Capture is best-effort
          // and must never mask or replace the underlying failure.
          const screenshotArtifactId = await this.diagnosticScreenshot(sessionId, pageId);
          if (screenshotArtifactId !== undefined) {
            result.error = {
              ...result.error,
              details: { ...result.error.details, screenshotArtifactId },
            };
          }
        }
        // F2: opt-in heal (raw-act parity with executePlan's self-heal). The
        // executor refuses a stale target BEFORE the engine acts, so the
        // engine-level remap inside act() is unreachable here - the heal has
        // to live at this layer, where the refusal is already a result.
        if (
          actRequest.remap === true &&
          ref !== undefined &&
          (result.error.code === 'STALE_TARGET' || result.error.code === 'TARGET_NOT_FOUND') &&
          // Only binding staleness may be healed. A refusal without the
          // flag carries live contradicting evidence (fingerprint mismatch,
          // the caller's own expectedRevision assertion) - remapping it
          // would overwrite semantics the executor deliberately refused on.
          result.error.details?.remapEligible === true
        ) {
          return await this.remapAct(sessionId, pageId, actRequest, ref, result.error);
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

      if (
        request.action === 'fill' &&
        request.expectValue !== undefined &&
        (result.result as { verified?: unknown } | undefined)?.verified !== true
      )
        throw new ServiceError(
          'ENGINE_UNSUPPORTED',
          'The adapter returned no fill verification evidence. The fill may have completed; inspect current state before another write.',
          false
        );

      // Post-action wait (spec 11.1): an explicit wait runs to its deadline
      // (returns WHY it completed; a missed deadline is ACTION_TIMEOUT,
      // never a hang). Without one, a zero-cost settle yield keeps latency
      // off the deterministic path - engines that need real settling take
      // an explicit wait.
      const waitReason =
        request.wait !== undefined
          ? await this.waitFor(page.enginePage, request.wait)
          : request.action === 'wait' && request.condition !== undefined
            ? await this.waitFor(page.enginePage, request.condition)
            : 'settled';

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
        ...(result.remap !== undefined ? { remap: result.remap } : {}),
        // Only publish the comparison boolean, never a field value.
        ...(request.action === 'fill' &&
        request.expectValue !== undefined &&
        (result.result as { verified?: unknown } | undefined)?.verified === true
          ? { result: { verified: true } }
          : {}),
        // Upload reports its separate attached-file evidence.
        ...(request.action === 'upload' && result.result != null ? { result: result.result } : {}),
      };
    });
  }

  /**
   * F3: the `steps` batch path. Deliberately a thin adapter over
   * executePlan - one implementation of sequencing, stop-on-first-error,
   * churn gating and the bounded self-heal - with the batch envelope's
   * own concerns (size limit, end-of-batch wait and observe) layered on
   * top. A failed step never throws: it is reported in-band.
   */
  private async executeActBatch(
    sessionId: string,
    pageId: string,
    request: ServiceActRequest
  ): Promise<ServiceBatchActResult> {
    const page = this.requirePage(sessionId, pageId);
    const steps = request.steps;
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) {
      throw new ServiceError(
        'INVALID_REQUEST',
        `'steps' must be an array of 1..20 actions; got ${steps?.length ?? 'non-array'}.`,
        false,
        { count: Array.isArray(steps) ? steps.length : undefined }
      );
    }
    if (request.wait !== undefined) {
      this.validateWaitCondition(request.wait, new Set<string>(DELIVERED_WAIT_TYPES));
    }

    const oldRevision = page.revision;
    const plan = await this.executePlan(sessionId, pageId, steps);

    // The top-level wait and observe belong to the batch, not to any step:
    // they run only when every step applied, so a failed batch reports its
    // failure without post-action noise masking it.
    let waitReason: string | undefined;
    if (plan.ok && request.wait !== undefined) {
      waitReason = await this.waitFor(page.enginePage, request.wait);
    }
    let observation: PageState | undefined;
    if (plan.ok && request.observe === 'after') {
      observation = await this.observe(sessionId, pageId, { mode: 'interactive' });
    }

    return {
      status: plan.ok ? 'success' : 'failed',
      completed: plan.completed,
      results: plan.results,
      oldRevision,
      newRevision: observation?.revision ?? plan.newRevision,
      mode: plan.mode,
      ...(waitReason !== undefined ? { waitReason } : {}),
      ...(observation !== undefined ? { observation } : {}),
      ...(plan.error !== undefined ? { error: plan.error } : {}),
    };
  }

  /**
   * F2: the opt-in heal behind `remap: true`. Re-observes, matches the
   * mint-time element by role + name (candidates arrive redacted from
   * observe(), the history baseline does not - compare on the redacted
   * form, or a label embedding a secret could never match itself), and
   * retries once when exactly one candidate survives. Zero or several
   * candidates refuse to guess with the candidate count in details; a
   * retry that itself fails propagates that failure honestly.
   */
  private async remapAct(
    sessionId: string,
    pageId: string,
    request: ServiceActRequest,
    staleRef: string,
    refusal: { code: ProtocolErrorCode; message: string }
  ): Promise<ServiceActResult> {
    const page = this.pages.get(pageId);
    if (page === undefined) {
      throw this.redactedError(new ServiceError(refusal.code, refusal.message));
    }
    // The observation the stale ref was minted from, via the ref's own
    // revision prefix - lastObservation may have been replaced by a heal or
    // observe-after since (same lookup executePlan's self-heal uses).
    const refRevision = /(?:^|e)(\d+)_/.exec(staleRef)?.[1];
    const baseline =
      (refRevision !== undefined
        ? page.history.get(Number.parseInt(refRevision, 10))?.byRef.get(staleRef)
        : undefined) ?? page.lastObservation?.byRef.get(staleRef);
    if (baseline === undefined) {
      throw this.redactedError(new ServiceError(refusal.code, refusal.message));
    }

    const observed = await this.observe(sessionId, pageId, { mode: 'interactive' });
    // An unnamed baseline must match unnamed candidates (undefined ===
    // undefined), not the redacted empty string - redact('') would compare
    // '' against every candidate's undefined name and never match.
    const baselineName =
      baseline.name === undefined ? undefined : this.secretManager.redact(baseline.name);
    const nameForMessages = baselineName ?? '<unnamed>';
    const matches = observed.elements.filter(
      (e) => e.role === baseline.role && e.name === baselineName
    );
    if (matches.length !== 1) {
      throw this.redactedError(
        new ServiceError(
          'STALE_TARGET',
          matches.length === 0
            ? `Remap found no element matching role '${baseline.role}' and name '${nameForMessages}'; the control is gone.`
            : `Remap found ${matches.length} candidates matching role '${baseline.role}' and name '${nameForMessages}'; refusing to guess.`,
          true,
          {
            ref: staleRef,
            revision: page.revision,
            role: baseline.role,
            ...(baselineName !== undefined ? { name: baselineName } : {}),
            candidates: matches.length,
          }
        )
      );
    }
    const fresh = matches[0];
    if (fresh === undefined) {
      throw this.redactedError(new ServiceError(refusal.code, refusal.message));
    }
    // remap is stripped from the retry: one heal per action, and a retry
    // failure surfaces instead of recursing. The retry is always the
    // single-action variant - remapAct is unreachable from the batch path.
    const retry = (await this.act(sessionId, pageId, {
      ...request,
      target: { ref: fresh.ref },
      remap: undefined,
    })) as ServiceActResult;
    return { ...retry, remap: { from: staleRef, to: fresh.ref } };
  }

  /**
   * Shape-and-pairing check for a delivered wait condition. The wire schema
   * constrains field types; this catches semantic misses that the schema
   * cannot express (minElements without count, urlPattern without a
   * pattern) BEFORE any step runs - a mid-plan failure here would leave a
   * half-applied batch behind.
   */
  private validateWaitCondition(wait: ServiceWaitCondition, delivered: Set<string>): void {
    if (!delivered.has(wait.until)) {
      throw new ServiceError(
        'INVALID_REQUEST',
        `Unknown wait condition '${wait.until}'. Supported: ${[...delivered].join(', ')}.`
      );
    }
    if (wait.until === 'urlPattern' && typeof wait.pattern !== 'string') {
      throw new ServiceError('INVALID_REQUEST', "Wait 'urlPattern' requires a string 'pattern'.");
    }
    if (wait.until === 'urlPattern' && typeof wait.pattern === 'string') {
      // Pre-flight the pattern (size cap + compile) so a bad regex fails as
      // INVALID_REQUEST before any step runs instead of mid-wait.
      if (wait.pattern.length > 512) {
        throw new ServiceError(
          'INVALID_REQUEST',
          "Wait 'urlPattern' pattern exceeds the 512-character limit."
        );
      }
      this.compileUrlPattern(wait.pattern);
    }
    if (wait.until === 'selectorVisible' && typeof wait.selector !== 'string') {
      throw new ServiceError(
        'INVALID_REQUEST',
        "Wait 'selectorVisible' requires a string 'selector'."
      );
    }
    if (
      wait.until === 'minElements' &&
      (typeof wait.count !== 'number' || !Number.isInteger(wait.count) || wait.count < 1)
    ) {
      throw new ServiceError(
        'INVALID_REQUEST',
        "Wait 'minElements' requires an integer 'count' >= 1."
      );
    }
  }

  /** Glob (`*` = within one path segment, `**` = anything) or `/regex/`. */
  private compileUrlPattern(pattern: string): RegExp {
    const regexForm = /^\/(.*)\/([a-z]*)$/.exec(pattern);
    if (regexForm) {
      try {
        return new RegExp(regexForm[1] ?? '', regexForm[2] ?? '');
      } catch {
        // Caller-supplied regex bodies can be syntactically invalid; that is
        // a bad request, not a mid-wait engine failure.
        throw new ServiceError('INVALID_REQUEST', `Wait 'urlPattern' regex is invalid: ${pattern}`);
      }
    }
    const source = pattern
      .split('*')
      .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join(pattern.includes('**') ? '[\\s\\S]*' : '[^/]*');
    return new RegExp(`^${source}$`);
  }

  /** Poll helper shared by the deadline-bounded F6/F7 conditions. */
  private async pollInterval(ms = 150): Promise<void> {
    await new Promise((wake) => setTimeout(wake, ms));
  }

  /**
   * Run one wait condition to its deadline (spec 11.1). Returns why it
   * completed. `settled` means a short quiet window on an engine that
   * supports load-state events; engines without the support settle
   * immediately (an explicit, bounded best-effort - recorded in the
   * reason, never a silent hang).
   */
  private async waitFor(enginePage: EnginePage, wait: ServiceWaitCondition): Promise<string> {
    const checked = validateDeliveredWaitCondition(wait);
    if (!checked.ok)
      throw new ServiceError(
        'INVALID_REQUEST',
        checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
      );
    // A wire-supplied 0 would disable the underlying engine timeouts
    // (Playwright treats explicit 0 as "wait forever"); every condition is
    // deadline-bounded, so clamp to a positive floor.
    const deadlineMs = Math.max(1, wait.timeoutMs ?? 5000);

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

    if (wait.until === 'urlPattern') {
      const regex = this.compileUrlPattern(wait.pattern ?? '');
      const start = Date.now();
      let url = '';
      for (;;) {
        url = (await enginePage.getUrl?.()) ?? '';
        if (regex.test(url)) {
          return 'urlPattern';
        }
        if (Date.now() - start >= deadlineMs) {
          throw new ServiceError(
            'ACTION_TIMEOUT',
            `Wait 'urlPattern' did not match within ${deadlineMs}ms.`,
            true,
            { until: 'urlPattern', timeoutMs: deadlineMs, url }
          );
        }
        await this.pollInterval();
      }
    }

    if (wait.until === 'selectorVisible') {
      const selector = wait.selector ?? '';
      const anyPage = enginePage as unknown as {
        waitForSelector?: (selector: string, options: { timeoutMs?: number }) => Promise<void>;
      };
      if (typeof anyPage.waitForSelector !== 'function') {
        throw new ServiceError(
          'ENGINE_UNSUPPORTED',
          'The active engine does not support selector waits.'
        );
      }
      try {
        await anyPage.waitForSelector(selector, { timeoutMs: deadlineMs });
        return 'selectorVisible';
      } catch {
        throw new ServiceError(
          'ACTION_TIMEOUT',
          `Wait 'selectorVisible' did not complete within ${deadlineMs}ms.`,
          true,
          { until: 'selectorVisible', timeoutMs: deadlineMs, selector }
        );
      }
    }

    if (wait.until === 'minElements') {
      const required = wait.count ?? 1;
      const start = Date.now();
      let observed = 0;
      for (;;) {
        try {
          const raw = await enginePage.observe({ mode: 'interactive' });
          observed = raw.elements.length;
        } catch {
          observed = 0;
        }
        if (observed >= required) {
          return 'minElements';
        }
        if (Date.now() - start >= deadlineMs) {
          throw new ServiceError(
            'ACTION_TIMEOUT',
            `Wait 'minElements' did not reach ${required} elements within ${deadlineMs}ms.`,
            true,
            { until: 'minElements', timeoutMs: deadlineMs, count: required, observed }
          );
        }
        await this.pollInterval();
      }
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
        if (this.isCrash(error)) {
          const errorDetail = this.secretManager.redact(
            error instanceof Error ? error.message : String(error)
          );
          await this.recoverFromCrash(sessionId, 'pdf: engine crashed', errorDetail);
          throw new ServiceError(
            'ENGINE_CRASHED',
            'The browser engine crashed; the session has been terminated.',
            false,
            { sessionId, errorDetail }
          );
        }
        throw error;
      }

      // Boundary check (not redundant with the CapturedArtifact type): that
      // type is compile-time only, and BrowserEngine is a plugged-in
      // interface a non-TypeScript engine could implement without it.
      // Fail with a diagnosable error naming the contract violation instead
      // of an opaque Buffer.from(undefined, ...) TypeError.
      if (typeof captured.bytesBase64 !== 'string') {
        throw new ServiceError(
          'INTERNAL',
          'The active engine returned a PDF capture with no bytesBase64 payload (BrowserEngine contract violation).',
          false,
          { sessionId }
        );
      }
      const bytes = Buffer.from(captured.bytesBase64, 'base64');
      const metadata = this.putArtifact(
        sessionId,
        'pdf',
        'application/pdf',
        new Uint8Array(bytes),
        {
          sessionId,
        }
      );
      const inline = this.inlineFor(captured.bytesBase64, bytes.byteLength);
      return { ...metadata, ...(inline !== undefined ? { inline } : {}) };
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
    return this.traced('download.fetch', { sessionId, pageId }, async () => {
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

      const owner = this.requireSession(sessionId);
      const transport = this.downloads.get(sessionId);
      if (!transport)
        throw new ServiceError('SESSION_NOT_FOUND', 'Session download owner is unavailable');
      const { bytes, contentType } = await transport.download(request.url, {
        maxBytes: policy.maxDownloadBytes,
      });
      owner.signal.throwIfAborted();
      this.requirePage(sessionId, pageId);

      if (bytes.length > policy.maxDownloadBytes) {
        throw new ServiceError(
          'DOWNLOAD_BLOCKED',
          `Payload is ${bytes.length} bytes; this session allows at most ${policy.maxDownloadBytes} bytes.`,
          false,
          { sizeBytes: bytes.length, maxDownloadBytes: policy.maxDownloadBytes }
        );
      }

      try {
        return this.putArtifact(sessionId, 'download', contentType, bytes, {
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
    });
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

      const policy = this.sessionDownloadPolicy.get(sessionId);
      if (!policy?.allowDownloads)
        throw new ServiceError('DOWNLOAD_BLOCKED', 'Downloads are disabled for this session');
      const captured = await this.requireSession(sessionId).engineSession.takeDownload?.(
        page.enginePage.id,
        filename
      );
      const bytes = captured?.bytes;

      if (bytes === undefined) {
        throw new ServiceError(
          'NOT_FOUND',
          `No captured download '${filename}' on this page. Downloads appear as download.finished events; collect after the event fires.`
        );
      }
      if (bytes.byteLength > policy.maxDownloadBytes)
        throw new ServiceError(
          'DOWNLOAD_BLOCKED',
          'Captured download exceeds the session byte limit'
        );
      const capturedFilename = captured?.filename ?? filename;

      const contentType = capturedFilename.endsWith('.csv')
        ? 'text/csv'
        : capturedFilename.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream';

      return this.putArtifact(sessionId, 'download', contentType, bytes, {
        filename: capturedFilename,
        sessionId,
      });
    });
  }

  /** Retrieve a stored artifact, scoped to its session. */
  getArtifact(
    sessionId: string,
    artifactId: string,
    tenantId?: string
  ): { metadata: ArtifactMetadata; bytes: Uint8Array } | undefined {
    const entry = this.artifacts.get(artifactId);
    if (!entry || entry.metadata.sessionId !== sessionId) {
      return undefined;
    }
    if (entry.metadata.controlEpoch !== undefined) {
      this.requireSession(sessionId);
      this.assertAuthority(sessionId);
      if (
        this.authority.isAgent() &&
        entry.metadata.controlEpoch !== this.authority.currentEpoch(sessionId)
      )
        throw new ServiceError('FORBIDDEN', 'Artifact belongs to another control generation');
    }
    if (tenantId !== undefined && entry.metadata.tenantId !== tenantId) {
      throw new ServiceError('FORBIDDEN', 'Artifact belongs to another tenant.');
    }
    return entry;
  }

  private putArtifact(
    sessionId: string,
    type: ArtifactMetadata['type'],
    contentType: string,
    bytes: Uint8Array,
    labels: { filename?: string; sessionId?: string } = {}
  ): ArtifactMetadata {
    this.assertAuthority(sessionId);
    const controlEpoch = this.authority.currentEpoch(sessionId);
    const owner = this.requireSession(sessionId).metadata.tenantId;
    return this.artifacts.put(type, contentType, bytes, {
      ...labels,
      ...(controlEpoch !== undefined ? { controlEpoch } : {}),
      sessionId,
      ...(owner !== undefined ? { tenantId: owner } : {}),
    });
  }

  /**
   * Best-effort evidence capture for ACTION_TIMEOUT diagnostics (F4): a
   * screenshot artifact of the page as the action deadline hit. Every
   * failure path returns undefined so the underlying timeout is reported
   * untouched.
   */
  private async diagnosticScreenshot(
    sessionId: string,
    pageId: string
  ): Promise<string | undefined> {
    try {
      const page = this.requirePage(sessionId, pageId);
      // Diagnostics must never extend the failure they describe: bound the
      // capture the same way the engine bounds its blocker probe.
      const captured = await Promise.race([
        page.enginePage.screenshot({ format: 'png' }),
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), 2_000);
          timer.unref();
        }),
      ]);
      if (captured === undefined || typeof captured.bytesBase64 !== 'string') {
        return undefined;
      }
      const metadata = this.putArtifact(
        sessionId,
        'screenshot',
        captured.contentType,
        new Uint8Array(Buffer.from(captured.bytesBase64, 'base64')),
        { sessionId }
      );
      return metadata.artifactId;
    } catch {
      return undefined;
    }
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
      format?: DeliveredExtractFormat;
      maxBytes?: number;
      schema?: Record<string, unknown>;
      records?: { container: string; fields: Record<string, string>; limit?: number };
    }
  ): Promise<import('@agentbrowser/engine').ExtractionResult> {
    return this.traced('extract', { sessionId, pageId, format: request.format }, async () => {
      let maxBytes: number;
      try {
        maxBytes =
          request.maxBytes === undefined
            ? this.extractMaxBytes
            : parseExtractMaxBytes(request.maxBytes);
        if (maxBytes > this.extractMaxBytes) throw new Error();
      } catch {
        throw new ServiceError(
          'INVALID_REQUEST',
          'Extraction maxBytes must be a positive safe integer within the server ceiling.',
          false,
          { serverMaxBytes: this.extractMaxBytes }
        );
      }
      const raw = await this.readPageSource(
        sessionId,
        pageId,
        'extract',
        request.format === 'forms'
      );
      const page = this.requirePage(sessionId, pageId);

      // Evidence attests to the service's revision of the page.
      const sourced: RawPageState = {
        ...raw,
        metadata: { ...(raw.metadata ?? {}), revision: page.revision },
      };

      const result = await (async () => {
        switch (request.format) {
          case 'text':
            return this.secretManager.redact(extractVisibleText(sourced));
          case 'markdown':
            return this.secretManager.redact(extractMarkdown(sourced));
          case 'links':
            return this.secretManager.redact(extractLinks(sourced));
          case 'tables':
            return this.secretManager.redact(extractTables(sourced));
          case 'forms':
            return this.secretManager.redact(extractForms(sourced));
          case 'jsonld': {
            const result = this.secretManager.redact(extractJsonLd(sourced));
            return { ...result, data: this.secretManager.redactUntrusted(result.data) };
          }
          case 'schema': {
            this.validateExtractSchema(request.schema);
            const extractor = new SchemaExtractor({
              ...(this.secretManager !== undefined ? { secretManager: this.secretManager } : {}),
            });
            return await extractor.extract(sourced, request.schema as Record<string, unknown>);
          }
          case 'records': {
            const recordsRequest = this.validateRecordsRequest(request.records);
            try {
              return this.secretManager.redact(extractRecords(sourced, recordsRequest));
            } catch (error) {
              // Caller-supplied selectors that are not valid CSS are a
              // request-shape problem: 400, never the parser's raw 500.
              if (error instanceof RecordsSelectorError) {
                throw new ServiceError('INVALID_REQUEST', error.message, false);
              }
              throw error;
            }
          }
          default:
            throw new ServiceError(
              'INVALID_REQUEST',
              `Unknown extraction format: ${String(request.format)}. Supported: text, markdown, links, tables, forms, jsonld, schema, records.`
            );
        }
      })();
      // One budget owner across all formats, measured after redaction. Never slice JSON,
      // structured records or evidence independently of their source result.
      const actualBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      if (actualBytes > maxBytes)
        throw new ServiceError(
          'OUTPUT_TRUNCATED',
          'Extraction exceeds maxBytes; no partial result returned. Increase the limit within the server ceiling or narrow the extraction.',
          false,
          { maxBytes, serverMaxBytes: this.extractMaxBytes, actualBytes }
        );
      return result;
    });
  }

  /**
   * Shape-check the records argument for format:'records' (TD-BROWSER-12):
   * a non-empty container selector plus at least one field selector, with
   * an optional integer limit (1–1000). Field values are collapsed text,
   * so non-string selectors are rejected before any page work.
   */
  private validateRecordsRequest(
    records: { container: string; fields: Record<string, string>; limit?: number } | undefined
  ): { container: string; fields: Record<string, string>; limit?: number } {
    if (records === undefined || typeof records !== 'object' || Array.isArray(records)) {
      throw new ServiceError(
        'INVALID_REQUEST',
        "format 'records' requires a records object: { container, fields }."
      );
    }
    if (Buffer.byteLength(JSON.stringify(records), 'utf8') > 65_536) {
      throw new ServiceError('INVALID_REQUEST', 'records exceeds the 64 KiB bound.');
    }
    if (typeof records.container !== 'string' || records.container.trim().length === 0) {
      throw new ServiceError(
        'INVALID_REQUEST',
        "records 'container' must be a non-empty CSS selector."
      );
    }
    if (
      records.fields === undefined ||
      typeof records.fields !== 'object' ||
      Array.isArray(records.fields) ||
      Object.keys(records.fields).length === 0
    ) {
      throw new ServiceError(
        'INVALID_REQUEST',
        "records 'fields' must be an object with at least one field → CSS selector entry."
      );
    }
    if (Object.values(records.fields).some((selector) => typeof selector !== 'string')) {
      throw new ServiceError('INVALID_REQUEST', 'every records field selector must be a string.');
    }
    if (
      records.limit !== undefined &&
      (!Number.isInteger(records.limit) || records.limit < 1 || records.limit > 1000)
    ) {
      throw new ServiceError('INVALID_REQUEST', "records 'limit' must be an integer 1–1000.");
    }
    return records;
  }

  /**
   * Shape-check the schema argument for format:'schema' (flat subset:
   * top-level `properties` object + optional `required` string array) with
   * a size bound. Previously any truthy JSON value passed through.
   */
  private validateExtractSchema(schema: Record<string, unknown> | undefined): void {
    if (schema === undefined) {
      throw new ServiceError(
        'INVALID_REQUEST',
        "format 'schema' requires a schema (JSON Schema object)."
      );
    }
    if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > 65_536) {
      throw new ServiceError('INVALID_REQUEST', 'schema exceeds the 64 KiB bound.');
    }
    if (
      typeof schema !== 'object' ||
      Array.isArray(schema) ||
      schema.properties === undefined ||
      typeof schema.properties !== 'object' ||
      Array.isArray(schema.properties)
    ) {
      throw new ServiceError(
        'INVALID_REQUEST',
        "schema must be an object with a top-level 'properties' object."
      );
    }
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== 'string'))
    ) {
      throw new ServiceError('INVALID_REQUEST', "schema 'required' must be an array of strings.");
    }
  }

  // ---- screenshots --------------------------------------------------------

  /**
   * F8: transport economics - small evidence rides the response body so a
   * screenshot/pdf/html round trip is one call, not capture + fetch. The
   * artifact is registered either way; the threshold only decides whether
   * the bytes ALSO travel inline. Env knob follows the snapshot-evidence
   * pattern: invalid or negative values fall back to the default, large
   * values clamp at the artifact store's own 10MiB ceiling.
   */
  private inlineArtifactMaxBytes(): number {
    const DEFAULT = 262144;
    const CEILING = 10 * 1024 * 1024;
    const raw = process.env.AGENTBROWSER_INLINE_ARTIFACT_MAX_BYTES;
    if (raw === undefined || raw.trim() === '') return DEFAULT;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT;
    return Math.min(parsed, CEILING);
  }

  private inlineFor(
    base64: string,
    byteSize: number
  ): { contentBase64: string; byteSize: number } | undefined {
    if (byteSize > this.inlineArtifactMaxBytes()) return undefined;
    return { contentBase64: base64, byteSize };
  }

  async screenshot(
    sessionId: string,
    pageId: string,
    request: ScreenshotRequest
  ): Promise<ArtifactMetadata> {
    const checked = validateScreenshotRequest(request);
    if (!checked.ok)
      throw new ServiceError(
        'INVALID_REQUEST',
        checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
      );
    return this.traced('screenshot', { sessionId, pageId }, async () => {
      const page = this.requirePage(sessionId, pageId);
      this.coordinator.updateActivity(sessionId);

      // Optional readiness wait before capture, so a JS SPA that has not painted
      // yet does not produce a blank image. Omitting `wait` is the fast default.
      if (request.wait !== undefined) {
        await this.waitFor(page.enginePage, request.wait as ServiceWaitCondition);
      }

      let captured: Awaited<ReturnType<EnginePage['screenshot']>>;
      try {
        captured = await page.enginePage.screenshot(request);
      } catch (error) {
        if (this.isCrash(error)) {
          const errorDetail = this.secretManager.redact(
            error instanceof Error ? error.message : String(error)
          );
          await this.recoverFromCrash(sessionId, 'screenshot: engine crashed', errorDetail);
          throw new ServiceError(
            'ENGINE_CRASHED',
            'The browser engine crashed; the session has been terminated.',
            false,
            { sessionId, errorDetail }
          );
        }
        throw error;
      }

      // Boundary check (not redundant with the CapturedArtifact type): that
      // type is compile-time only, and BrowserEngine is a plugged-in
      // interface a non-TypeScript engine could implement without it.
      // Fail with a diagnosable error naming the contract violation instead
      // of an opaque Buffer.from(undefined, ...) TypeError.
      if (typeof captured.bytesBase64 !== 'string') {
        throw new ServiceError(
          'INTERNAL',
          'The active engine returned a screenshot capture with no bytesBase64 payload (BrowserEngine contract violation).',
          false,
          { sessionId }
        );
      }
      const bytes = Buffer.from(captured.bytesBase64, 'base64');
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

      const metadata = this.putArtifact(
        sessionId,
        'screenshot',
        captured.contentType,
        new Uint8Array(bytes),
        {
          sessionId,
        }
      );
      const inline = this.inlineFor(captured.bytesBase64, bytes.byteLength);
      return {
        ...metadata,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(inline !== undefined ? { inline } : {}),
      };
    });
  }

  // ---- shutdown -----------------------------------------------------------

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const transport of this.downloads.values())
      transport.revoke(new ServiceError('SESSION_NOT_FOUND', 'Service shutdown'));
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
    }
    await this.coordinator.shutdown();
    for (const sessionId of this.sessionDownloadPolicy.keys()) this.deleteSessionState(sessionId);
    this.pages.clear();
    await this.approvalGate.shutdown();
    // Registry aliases may point to the same engine instance. Every distinct
    // owner must release its pool/connection even if another close fails.
    const engines = new Set([this.engine, ...this.engines.values()]);
    const results = await Promise.allSettled([...engines].map(async (engine) => engine.close()));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  // ---- internals ----------------------------------------------------------

  private assertAuthority(sessionId: string): void {
    const context = this.requireSession(sessionId);
    if (this.controlledContexts.has(context)) this.authority.assert(sessionId);
  }

  private guardPage(sessionId: string, page: EnginePage): EnginePage {
    const context = this.requireSession(sessionId);
    return this.controlledContexts.has(context) ? this.authority.guardPage(sessionId, page) : page;
  }

  private requireSession(sessionId: string) {
    const session = this.coordinator.get(sessionId);
    if (!session) {
      throw new ServiceError('SESSION_NOT_FOUND', `Session ${sessionId} does not exist.`);
    }
    return session;
  }

  private requirePage(sessionId: string, pageId: string): PageContext {
    this.assertAuthority(sessionId);
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
  private reviewContext(sessionId: string) {
    if (this.sessionApprovalPolicies.get(sessionId)?.review !== 'operator')
      throw new ServiceError('INVALID_REQUEST', 'Session does not use operator-reviewed approval');
    return this.authority.reviewBindingInScope(sessionId);
  }

  private assertReviewContext(sessionId: string, expected: ApprovalReviewBinding): void {
    if (canonicalJson(this.reviewContext(sessionId)) !== canonicalJson(expected))
      throw new ServiceError('CONTROL_REVOKED', 'Review authority changed.');
  }

  /** Only call on bounded, detached owner data, never caller objects or callbacks. */
  private assertReviewDisclosureSafe(value: unknown): void {
    if (JSON.stringify(this.secretManager.redactUntrusted(value)) !== JSON.stringify(value))
      throw new ServiceError(
        'POLICY_DENIED',
        'Operator review of registered secret data is not supported'
      );
  }

  /** Resolve a stored review without exposing its private action or witness to configuration. */
  private async resolveApproval(
    sessionId: string,
    tokenId: string,
    intendedReview?: PreparedApplicationOperationReview
  ) {
    const context = this.reviewContext(sessionId);
    const current = await this.approvalGate.getReviewedApproval(tokenId, context);
    this.authority.assert(sessionId);
    if (!current) throw new ServiceError('NOT_FOUND', 'Current approval is unavailable');
    if (current.action.type !== NATIVE_FORM_REVIEW_TYPE) {
      if (intendedReview) throw new ServiceError('NOT_FOUND', 'Current approval is unavailable');
      return {
        context,
        current,
        prepared: undefined,
        assertPinned: undefined,
        application: undefined,
      };
    }

    const selector = selectEvidenceReview(current.action);
    if (!selector) throw new ServiceError('NOT_FOUND', 'Current approval is unavailable');
    let application = intendedReview;
    try {
      if (selector.application) {
        // selectEvidenceReview validated this complete gate-owned action. Its
        // private input stays here; the provider receives only routing identity.
        const action = (current.action.parameters as { action: Readonly<Record<string, unknown>> })
          .action;
        application ??= this.applicationAuthority.prepareOperationReviewInScope(sessionId, {
          operation: selector.application.operation,
          operationId: selector.application.operationId,
          expectedVersion: selector.application.expectedVersion,
          input: action.input,
        });
        application.assertCurrent();
        if (canonicalJson(application.action) !== canonicalJson(action))
          throw new Error('Application review changed');
      } else if (application) {
        throw new Error('Expected application review');
      }
    } catch {
      throw new ServiceError('NOT_FOUND', 'Current approval is unavailable');
    }
    return {
      context,
      current,
      application,
      ...this.prepareConfiguredEvidenceReview(sessionId, context, selector, application),
    };
  }

  /** One provider capture/composition path for creation and stored review resolution. */
  private prepareConfiguredEvidenceReview(
    sessionId: string,
    context: ApprovalReviewBinding,
    selector: EvidenceReviewSelector,
    application?: PreparedApplicationOperationReview,
    capturedPage?: PreparedNativeFormRead
  ): { prepared: PreparedEvidenceReview; assertPinned: () => void; assertOwners: () => void } {
    let assertPinned: (() => void) | undefined;
    try {
      const provider = this.evidenceReviewProvider;
      if (!provider) throw new Error('Unavailable provider');
      const page = capturedPage ?? this.prepareNativeFormReadInScope(sessionId, selector.pageId);
      assertPinned = () => {
        application?.assertCurrent();
        page.assertAuthority();
        this.assertReviewContext(sessionId, context);
      };
      assertPinned();
      if (
        page.identity.sessionId !== sessionId ||
        page.identity.pageId !== selector.pageId ||
        page.identity.sessionIncarnation !== context.sessionIncarnation
      )
        throw new Error('Unavailable review page');
      const request = snapshotAuthorizationInput({
        identity: {
          tenant: context.tenant,
          sessionId,
          sessionIncarnation: context.sessionIncarnation,
          pageId: selector.pageId,
        },
        source: selector.source,
        ...(selector.application ? { application: selector.application } : {}),
      }) as ServiceEvidenceReviewRequest;
      assertPinned();
      const readContext: ServiceEvidenceReviewContext = Object.freeze({ nativeForm: page });
      const configured = synchronousResult(
        Reflect.apply(provider, undefined, [request, readContext])
      );
      assertPinned();
      if (!configured || typeof configured !== 'object' || Array.isArray(configured))
        throw new Error('Unavailable provider result');
      const own = Object.getOwnPropertyDescriptors(configured);
      if (
        Object.getPrototypeOf(configured) !== Object.prototype ||
        Reflect.ownKeys(own).some((key) => key !== 'action' && key !== 'source') ||
        !own.action ||
        !Object.hasOwn(own.action, 'value') ||
        !own.action.enumerable ||
        !own.source ||
        !Object.hasOwn(own.source, 'value') ||
        !own.source.enumerable
      )
        throw new Error('Unavailable provider result');
      const action = snapshotAuthorizationInput(own.action.value);
      if (!action || typeof action !== 'object' || Array.isArray(action))
        throw new Error('Unavailable provider action');
      if (application && canonicalJson(action) !== canonicalJson(application.action))
        throw new Error('Approval does not match intended application operation');
      const source = captureEvidenceReviewSource(own.source.value);
      assertPinned();
      if (
        canonicalJson({ ownerId: source.ownerId, contract: source.contract }) !==
        canonicalJson(request.source)
      )
        throw new Error('Unavailable source identity');
      const prepared = this.prepareBoundEvidenceReview(
        sessionId,
        selector.pageId,
        { action: action as Record<string, unknown>, source },
        application,
        page
      );
      assertPinned();
      const assertOwners = () => {
        application?.assertPinned();
        page.assertAuthority();
        this.assertReviewContext(sessionId, context);
      };
      return { prepared, assertPinned, assertOwners };
    } catch {
      try {
        assertPinned?.();
      } catch {
        /* Keep source and callback diagnostics private. */
      }
      throw new ServiceError('NOT_FOUND', 'Current approval is unavailable');
    }
  }

  /** Existing wire callers share preparation with later guarded publishers. */
  async getApproval(sessionId: string, tokenId: string): Promise<OperatorApprovalView> {
    return (await this.prepareApprovalDisclosureInScope(sessionId, tokenId)).view;
  }

  async decideApproval(
    sessionId: string,
    tokenId: string,
    decision: 'approve' | 'deny'
  ): Promise<OperatorApprovalView> {
    if (decision !== 'approve' && decision !== 'deny')
      throw new ServiceError('INVALID_REQUEST', 'Approval decision must be approve or deny');
    return (await this.prepareApprovalDisclosureInScope(sessionId, tokenId, decision)).view;
  }

  /** Capture a stored view while executing; later checks never repeat the lookup/decision. */
  async prepareApprovalDisclosureInScope(
    sessionId: string,
    tokenId: string,
    decision?: 'approve' | 'deny'
  ): Promise<PreparedReviewDisclosure> {
    const resolved = await this.resolveApproval(sessionId, tokenId);
    this.assertReviewContext(sessionId, resolved.context);
    if (resolved.prepared) {
      try {
        const signal = this.authority.signal(sessionId);
        const result =
          decision === undefined
            ? await resolved.prepared.get(tokenId, signal)
            : await resolved.prepared.decide(tokenId, decision, signal);
        if (result) {
          const disclosure = resolved.prepared.capturePublication(result);
          resolved.assertOwners();
          this.assertReviewDisclosureSafe(disclosure.view);
          resolved.assertOwners();
          return disclosure;
        }
      } catch {
        // Source permission and authority failures are indistinguishable from absence.
      }
      throw new ServiceError('NOT_FOUND', 'Current approval is unavailable');
    }
    const review = this.authority.captureReviewPublicationInScope(sessionId);
    const pageId = resolved.current.action.pageId;
    if (pageId !== undefined && typeof pageId !== 'string')
      throw new ServiceError('NOT_FOUND', 'Current approval is unavailable');
    const page = pageId === undefined ? undefined : this.capturePageOwnerInScope(sessionId, pageId);
    this.assertReviewDisclosureSafe(resolved.current);
    const result =
      decision === undefined
        ? resolved.current
        : await this.approvalGate.decideReviewedApproval(tokenId, resolved.context, decision);
    this.authority.assert(sessionId);
    if (!result)
      throw new ServiceError('NOT_FOUND', 'Current approval cannot accept that decision');
    this.assertReviewContext(sessionId, resolved.context);
    page?.assertAuthority();
    const assertPublication = () => {
      review.assertCurrent();
      page?.publication.assertCurrent();
    };
    const assertExecution = () => {
      this.assertReviewContext(sessionId, resolved.context);
      page?.assertAuthority();
    };
    const disclosure = captureReviewDisclosure(result, {
      assertExecution,
      assertCurrent: assertPublication,
      assertPinned: assertPublication,
      assertDisclosureSafe: (view) => this.assertReviewDisclosureSafe(view),
    });
    // Legacy wire callers unwrap the view before publication adoption. Pin their
    // execution owners after the last secret callback, without invoking host policy.
    assertExecution();
    return disclosure;
  }

  private async checkApproval(
    sessionId: string,
    pageId: string,
    page: PageContext,
    request: ServiceActRequest,
    identity?: string,
    span?: import('@agentbrowser/core').Span | undefined
  ): Promise<void> {
    const ref = request.target?.ref;
    const element = ref !== undefined ? page.lastObservation?.byRef.get(ref) : undefined;
    // Cached observations can precede history or out-of-band navigation.
    // Older adapters fall back to a live observation, never an empty/stale URL.
    const currentUrl = page.enginePage.getUrl
      ? await page.enginePage.getUrl()
      : (await page.enginePage.observe({})).url;
    const { effect: risk, decision } = this.actionRiskPolicy.evaluate(
      {
        action: request.action,
        url: currentUrl,
        ...(element ? { element } : {}),
      },
      this.sessionApprovalPolicies.get(sessionId)
    );
    if (decision === 'allow') return;
    if (decision === 'deny')
      throw new ServiceError(
        'POLICY_DENIED',
        `Operator/session approval policy denies '${risk}' actions.`,
        false,
        { effect: risk }
      );
    const decoded = decodeWireAction(request);
    if (!decoded.ok) throw new ServiceError('INVALID_REQUEST', 'Invalid approval action');

    const approvalRequest = {
      sessionId,
      action: {
        type: request.action,
        effect: risk,
        ...(ref !== undefined ? { target: { ref } } : {}),
        pageId,
        revision: page.revision,
        url: currentUrl,
        ...(identity !== undefined ? { identity } : {}),
        parameters: { ...decoded.value },
        ...(request.value !== undefined ? { value: request.value } : {}),
      },
    };

    if (this.sessionApprovalPolicies.get(sessionId)?.review === 'operator') {
      const context = this.reviewContext(sessionId);
      // A mutable vault reference is not a value witness, and review must not expose
      // vault plaintext. Qualify this separately before supporting reviewed secrets.
      if (request.value !== undefined && this.secretManager.isReference(request.value))
        throw new ServiceError(
          'POLICY_DENIED',
          'Operator-reviewed vault references are not supported'
        );
      const reviewedRequest = JSON.parse(canonicalJson(approvalRequest)) as typeof approvalRequest;
      this.assertReviewDisclosureSafe(reviewedRequest);
      if (
        request.approvalToken !== undefined &&
        (await this.approvalGate.consumeReviewedApproval(
          request.approvalToken,
          reviewedRequest,
          context
        ))
      ) {
        this.authority.assert(sessionId);
        if (span)
          this.tracer?.addEvent(span, 'approval.granted', {
            effect: risk,
            ref,
            review: 'operator',
          });
        return;
      }
      const token = await this.approvalGate.generateReviewedApproval(reviewedRequest, context);
      this.authority.assert(sessionId);
      if (span)
        this.tracer?.addEvent(span, 'approval.required', { effect: risk, ref, review: 'operator' });
      throw new ServiceError(
        'APPROVAL_REQUIRED',
        'Action requires an explicit operator decision.',
        false,
        { tokenId: token.tokenId, effect: risk, ref, review: 'operator' }
      );
    }

    if (request.approvalToken !== undefined) {
      const consumed = await this.approvalGate.consumeApprovalToken(
        request.approvalToken,
        approvalRequest
      );
      if (consumed) {
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
      error.details !== undefined ? this.secretManager.redactUntrusted(error.details) : undefined
    );
  }

  private mapError(error: unknown, operation = 'act'): ServiceError {
    if (error instanceof ServiceError) {
      return this.redactedError(error);
    }
    const failure = normalizeEngineError(error, operation);
    return this.redactedError(
      new ServiceError(failure.code, failure.message, failure.retryable, failure.details)
    );
  }
}

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

  async getTitle(): Promise<string | undefined> {
    return this.inner.getTitle?.();
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
    // Navigate is handled by navigate(); dialog actions, hover and the
    // wait action are non-mutating. Everything else advances the service
    // revision.
    const nonMutating =
      action.type === 'navigate' ||
      action.type === 'hover' ||
      action.type === 'wait' ||
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
