import { createReadStream } from 'node:fs';
import { ControlError, MAX_COOKIE_COUNT } from '@agentbrowser/core';
import { deploymentModeFromEnvironment } from './cdp-config.js';
import {
  cdpAttachAdmission,
  FLOOR_DELEGATED_REQUIRES_OPERATOR,
  FLOOR_OPERATOR_REQUIRED,
  isOperatorLoopback,
  type OperatorCdpAdmissionOptions,
  requireCdpAttachAdmission,
} from './floor.js';
import {
  JournalConfigError,
  journalConfigFromEnvironment,
  journalHistoryFromEnvironment,
  journalHistoryWarnings,
  journalRuntimeQualified,
  openServiceJournalSet,
  SERVICE_JOURNAL_RETAIN_MS,
  searchJournalNamespaces,
} from './journal-config.js';
import { operatorCsp, operatorHtml } from './operator-panel.js';
import type { SessionPrincipal } from './session-authority.js';
/**
 * AgentBrowser REST API Server
 *
 * Fastify-based REST API server providing session management, navigation,
 * observation, and action execution endpoints. Routes are a thin translation
 * layer over AgentBrowserService; the engine is injected, so tests run
 * against FakeEngine and production runs PlaywrightChromiumEngine.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  RESERVED_BROWSER_ADAPTER_ID,
  type TrustedEvidenceSourceRegistry,
  type TrustedVerifierRegistry,
} from '@agentbrowser/control';
import type { StructuredLogger } from '@agentbrowser/core';
import { InMemoryTracer, MetricsRegistry, type SecretManager } from '@agentbrowser/core';
import type { BrowserEngine } from '@agentbrowser/engine';
import { LoginBrowserError } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import type { AgentCapability, SessionPolicy } from '@agentbrowser/protocol';
import {
  agentModeAllows,
  CONTROL_OPERATION_ID,
  classifyJournalRecord,
  DEFAULT_EXTRACT_MAX_BYTES,
  DELIVERED_ACTION_TYPES,
  DELIVERED_EXTRACT_FORMATS,
  ErrorCode,
  EVENT_REPLAY_MIN_SINCE,
  isAgentMode,
  parseExtractMaxBytes,
  parsePlanSteps,
  validateCookieHandoffRequest,
  validateOperatorApprovalDecision,
  validateSessionRequest,
  validateWireAction,
  validateWireActionBatch,
} from '@agentbrowser/protocol';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { ArtifactAuthorizer } from './artifact-auth.js';
import { artifactStoreFromEnvironment } from './artifact-config.js';
import { engagementConfigFromEnvironment } from './engagement-config.js';
import {
  createHttpPublication,
  type HttpResponseDraft,
  responseDraft,
} from './http-publication.js';
import { LoginBrowserService } from './login-browser-service.js';
import { buildOpenApiDocument } from './openapi.js';
import { operatorKeysFromEnvironment, operatorKeysFromFile } from './operator-keys.js';
import { TokenBucketLimiter } from './policy-query-limiter.js';
import { POLICY_BEARING_ENV, sessionPolicyFactoryFor } from './policy-session.js';
import { PRODUCT_VERSION } from './product-version.js';
import { requestOriginGuardFromEnvironment } from './request-origin-guard.js';
import {
  AgentBrowserService,
  browserFailureOutcomeUnknown,
  browserReportOutcomeUnknown,
  copyBrowserReport,
  type ServiceActRequest,
  ServiceError,
  type ServiceEvidenceSourceBuilder,
  type ServiceOutcomeEvidenceContext,
  type ServiceSessionRequest,
} from './service.js';

/** One registered HTTP route, recorded for the contract-completeness gates. */
export interface RegisteredRoute {
  method: string;
  url: string;
  capability: AgentCapability | undefined;
  publication?: 'guarded' | 'when-controlled' | 'lifecycle' | 'stream';
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Delegated-grant capability this route requires (see the `on` helper). */
    capability?: AgentCapability;
    publication?: 'guarded' | 'when-controlled' | 'lifecycle' | 'stream';
    /** TD-BROWSER-16 phase 1: human-operator keys are valid here and only here. */
    operatorRoute?: boolean;
  }
  interface FastifyInstance {
    /**
     * Every route registered on this server (auto-generated HEAD duplicates
     * filtered). Collected for the openapi completeness gates; read-only.
     */
    readonly registeredRoutes: RegisteredRoute[];
  }
}

export interface ServerOptions extends OperatorCdpAdmissionOptions {
  /** Maximum compact JSON extraction response bytes; defaults to 1 MiB. */
  extractMaxBytes?: number;
  /**
   * TD-BROWSER-16 phase 4: enable the operator login browser
   * (AGENTBROWSER_LOGIN_BROWSER=1). Requires operator keys; hosted and
   * multi-tenant deployments refuse to open it.
   */
  loginBrowser?: boolean;
  /**
   * TD-BROWSER-16 phase 6: override the login-browser port the service reads
   * through (tests and embedders inject a fake; the operator routes still use
   * the real service above).
   */
  loginBrowserPort?: import('./service.js').ServiceDependencies['loginBrowser'];
  /**
   * TD-BROWSER-15 phase 4: a loaded policy file. Its authorizer decides every
   * operator-chosen question, its limits replace the embedder options, and
   * combining it with any of them is a startup refusal that names every
   * conflict.
   */
  policy?: {
    /**
     * `'file'` (default): AGENTBROWSER_POLICY_FILE — limits replace the
     * embedder options, and combining them is a refusal. `'shadow'`:
     * AGENTBROWSER_POLICY_SHADOW — the environment configuration still
     * applies, the wrapper only observes alongside the deciding authorizer.
     */
    kind?: 'file' | 'shadow';
    /** The loaded authorizer (CedarAuthorizer, or a shadow wrapper). */
    authorizer: import('@agentbrowser/policy-engine').Authorizer & {
      healthy?: boolean;
      shadowHealthy?: boolean;
    };
    /** The document's SHA-256; sessions stamp it. */
    version: string;
    /** Limits replacing extractMaxBytes / maxResponseBytes (files only). */
    limits: import('@agentbrowser/protocol').PolicyLimits;
    /**
     * The document's `approvalRules` and `unknownRisk` (files only): its rules classify each
     * action's effect before the authorizer decides. The environment approval policy is
     * refused alongside a file, so without this a file's rules would never classify anything.
     */
    approval?: import('@agentbrowser/core').ActionRiskPolicyOptions;
  };
  /** Trusted embedding source selection for private evidence-backed approval records. */
  evidenceReviewProvider?: import('./service.js').ServiceDependencies['evidenceReviewProvider'];
  /** Operator-owned rules. Client-supplied session policy can only restrict these. */
  approvalPolicy?: import('@agentbrowser/core').ActionRiskPolicyOptions;
  /** Trusted embedding only; session host rules can restrict but never weaken these rules. */
  networkPolicy?: import('@agentbrowser/policy').NetworkPolicy;
  port?: number;
  host?: string;
  /**
   * Exact browser origins allowed to call the API, merged with
   * AGENTBROWSER_CORS_ORIGINS. Default none: cross-origin browser requests
   * are refused (request-origin-guard.ts). '*' opts out, loudly warned.
   */
  corsOrigin?: string | string[];
  /** Browser engine backing the server. Production must inject a real one. */
  engine?: BrowserEngine;
  /**
   * TD-BROWSER-7 Phase 1/2: named auxiliary engines for per-session routing
   * (e.g. `safari` -> SafaridriverEngine). Unknown names fail loudly.
   */
  engines?: Record<string, BrowserEngine>;
  /** Download payload fetcher; injectable so tests never touch the network. */
  downloader?(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Metrics registry exposed at /metrics; defaults to a fresh registry. */
  metrics?: MetricsRegistry;
  /** Span tracer; defaults to a bounded in-memory tracer (exportable per session). */
  tracer?: InMemoryTracer;
  /** Secret registry used to scrub traces/observations; defaults to empty. */
  secretManager?: SecretManager;
  /** Structured operation log; when absent, no operation logging. */
  logger?: StructuredLogger;
  /** Session-default overrides plumbed to the coordinator (see ServiceDependencies). */
  defaultTtlMs?: number;
  defaultIdleTimeoutMs?: number;
  /**
   * Bearer-key authentication: SHA-256(key) -> tenantId. When absent (and no
   * AGENTBROWSER_API_KEYS env), auth is disabled with a loud warning -
   * the spec's trusted single-tenant local mode.
   */
  apiKeys?: Map<string, string>;
  /** Trusted deployment-owned verifier registry for the optional outcome endpoint. */
  verifierRegistry?: TrustedVerifierRegistry;
  /** Trusted evidence adapters; request bodies cannot register or select arbitrary code. */
  evidenceSourceRegistry?: TrustedEvidenceSourceRegistry<ServiceOutcomeEvidenceContext>;
  /** Lazy evidence composition over this service's application authority. */
  evidenceSourceRegistryProvider?: (
    sources: ServiceEvidenceSourceBuilder
  ) => TrustedEvidenceSourceRegistry<ServiceOutcomeEvidenceContext>;
  /**
   * Trusted application adapters for the shared-infra application surface.
   * Without adapters the application routes fail closed: no binding can be
   * created, so discovery returns none and execution is refused.
   */
  applicationAdapters?: import('@agentbrowser/control').ApplicationAdapter[];
}

/** SHA-256 hex digest. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Parse AGENTBROWSER_API_KEYS ("key:tenant,key:tenant,...") into a
 * hash-keyed map; undefined when the variable is unset.
 */
export function apiKeysFromEnv(): Map<string, string> | undefined {
  const raw = process.env.AGENTBROWSER_API_KEYS;
  if (raw === undefined) {
    return undefined;
  }
  const keys = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const separator = pair.lastIndexOf(':');
    if (separator <= 0) {
      throw new Error('Invalid AGENTBROWSER_API_KEYS configuration');
    }
    const key = pair.slice(0, separator).trim();
    const tenant = pair.slice(separator + 1).trim();
    const digest = sha256Hex(key);
    if (!key || !tenant || (keys.has(digest) && keys.get(digest) !== tenant))
      throw new Error('Invalid AGENTBROWSER_API_KEYS configuration');
    keys.set(digest, tenant);
  }
  return keys;
}

/**
 * Map protocol error codes onto HTTP statuses (hygiene F3).
 *
 * Exhaustive over the ErrorCode enum: the `satisfies Record<ErrorCode,
 * number>` check makes this a compile error the moment a new code is added
 * without a mapping - the hand-maintained switch previously drifted to 6
 * unmapped members, three of them LIVE-thrown (ACTION_TIMEOUT with
 * retryable=true reached clients as an incoherent 500; ENGINE_CRASHED as
 * 500; INVALID_TENANT_ID wasn't even in the enum, violating the protocol
 * error schema).
 */
const STATUS_FOR = {
  [ErrorCode.SESSION_BUSY]: 409,
  [ErrorCode.CONTROL_REVOKED]: 409,
  [ErrorCode.CONTROL_REQUIRED]: 403,
  [ErrorCode.OPERATION_CONFLICT]: 409,
  // 400 family: the request was bad (bad shape, bad target, bad tenant).
  [ErrorCode.INVALID_REQUEST]: 400,
  [ErrorCode.INVALID_TENANT_ID]: 400,
  [ErrorCode.STALE_TARGET]: 400,
  [ErrorCode.TARGET_NOT_FOUND]: 400,
  [ErrorCode.TARGET_AMBIGUOUS]: 400,
  [ErrorCode.TARGET_NOT_VISIBLE]: 400,
  [ErrorCode.TARGET_DISABLED]: 400,
  [ErrorCode.OUTPUT_TRUNCATED]: 400,
  // Auth/permission.
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.POLICY_DENIED]: 403,
  [ErrorCode.APPROVAL_REQUIRED]: 403,
  [ErrorCode.DOWNLOAD_BLOCKED]: 403,
  // Gone.
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.SESSION_NOT_FOUND]: 404,
  [ErrorCode.JOURNAL_UNAVAILABLE]: 503,
  [ErrorCode.PAGE_NOT_FOUND]: 404,
  [ErrorCode.SESSION_EXPIRED]: 410,
  // The service could not satisfy the request shape (engine can't do it).
  [ErrorCode.ENGINE_UNSUPPORTED]: 422,
  // Too much.
  [ErrorCode.QUOTA_EXCEEDED]: 429,
  // The browser side timed out waiting (retryable per the service).
  [ErrorCode.NAVIGATION_TIMEOUT]: 504,
  [ErrorCode.ACTION_TIMEOUT]: 504,
  // In-band today (plan envelope, HTTP 200); mapped in case it's ever
  // thrown as a ServiceError.
  [ErrorCode.PLAN_WAIT_TIMEOUT]: 504,
  // A page-side script reverted the filled value after two attempts.
  [ErrorCode.VALUE_MISMATCH]: 422,
  // Server-side failures.
  [ErrorCode.ENGINE_CRASHED]: 500,
  [ErrorCode.INTERNAL]: 500,
  // Login browser refusals (TD-BROWSER-16): operator mistakes, not server
  // faults — every one is a 4xx so clients can distinguish them from 500s.
  [ErrorCode.LOGIN_BROWSER_CLOSED]: 409,
  [ErrorCode.LOGIN_PROFILE_IN_USE]: 409,
  [ErrorCode.LOGIN_PROFILE_MODE]: 403,
  [ErrorCode.LOGIN_BROWSER_DISPLAY]: 400,
  [ErrorCode.LOGIN_BINARY_CHANGED]: 409,
  [ErrorCode.LOGIN_BINARY_DOWNGRADED]: 409,
  [ErrorCode.LOGIN_HOSTED_OR_MULTI_TENANT]: 403,
  [ErrorCode.HANDOFF_COOKIES_NOT_EXPORTABLE]: 403,
} satisfies Record<ErrorCode, number>;

/** Map protocol error codes onto HTTP statuses. */
function statusFor(code: string): number {
  return STATUS_FOR[code as ErrorCode] ?? 500;
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  let extractMaxBytes = parseExtractMaxBytes(options.extractMaxBytes ?? DEFAULT_EXTRACT_MAX_BYTES);
  // Validate before allocating service resources. Own the credential map so a
  // caller clearing it later cannot switch a running service into local mode.
  const configuredKeys = options.apiKeys ?? apiKeysFromEnv();
  const apiKeys = configuredKeys === undefined ? undefined : new Map(configuredKeys);
  // TD-BROWSER-16 phase 1: operator keys from a file, never a variable. They
  // authenticate a human operator for the one configured tenant and are
  // refused everywhere except operator-flagged routes.
  // The parser enforces the whole contract (overlap, single tenant, and
  // that API keys are configured at all) against the hashed map.
  const operatorKeys = await operatorKeysFromEnvironment(process.env, {
    ...(apiKeys !== undefined ? { apiKeys } : {}),
  });
  const bindHost = options.host ?? process.env.HOST ?? '127.0.0.1';
  const originGuard = requestOriginGuardFromEnvironment(
    process.env,
    bindHost,
    options.corsOrigin,
    console.warn,
    (apiKeys?.size ?? 0) > 0
  );
  const deploymentMode =
    deploymentModeFromEnvironment(process.env) === 'hosted'
      ? 'hosted'
      : (options.deploymentMode ?? 'local');
  const attachAdmission = cdpAttachAdmission(
    { ...options, host: bindHost, deploymentMode },
    apiKeys?.values() ?? []
  );
  const fastify = Fastify({
    logger: false, // Disable logging for cleaner test output
  });

  // Error handler — registered before any route or awaited plugin so it
  // governs every encapsulation context in this build (an awaited
  // fastify.register() mid-build splits the root context: handlers added
  // afterwards never see routes registered earlier, which leaked raw
  // handler-thrown error text on unauthenticated routes).
  fastify.setErrorHandler((error: FastifyError, _request, reply) => {
    // An escaped protocol error serializes exactly as the route wrapper's
    // fail() would — one shared serializer, not a hand-synced copy.
    if (error instanceof ControlError || error instanceof ServiceError) {
      return fail(reply, error);
    }

    const fstError = typeof error.code === 'string' && error.code.startsWith('FST_ERR_');
    const status = error.statusCode ?? 500;

    // fastify's own logger is a noop under logger:false; this is the only
    // sink for framework-plane faults (route-plane failures are logged by
    // fail(), whose wrapper catches them before this handler runs). 5xx
    // only — client mistakes are normal traffic, not error-rate signal.
    // Unregistered diagnostics and request URLs can contain credentials, so
    // the sink receives only a fixed code and numeric status.
    if (status >= 500) {
      try {
        options.logger?.error('http.framework_error', {
          code: 'INTERNAL',
          status: typeof status === 'number' && Number.isInteger(status) ? status : 500,
        });
      } catch {
        // Logging must not replace the safe response with a sink's private diagnostic.
      }
    }

    // Fastify's built-in 5xx are server faults: generic INTERNAL body —
    // never the raw internal text, never the client-fault code.
    if (fstError && status >= 500) {
      return reply.status(status).send({
        error: {
          code: 'INTERNAL',
          message: 'An unexpected error occurred',
          retryable: false,
        },
      });
    }

    // Built-in and 4xx-classified client errors keep their original status
    // with a redacted request-diagnostic message.
    if (fstError || (status >= 400 && status < 500)) {
      return reply.status(status).send({
        error: {
          code: status === 404 ? 'NOT_FOUND' : 'INVALID_REQUEST',
          message:
            options.secretManager?.redact(error.message || 'Request failed') ??
            (error.message || 'Request failed'),
          retryable: false,
        },
      });
    }

    // For all other errors, return 500 INTERNAL
    return reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: 'An unexpected error occurred',
        retryable: false,
      },
    });
  });

  // 404 handler
  fastify.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        retryable: false,
      },
    });
  });

  // Browser-provenance guard (request-origin-guard.ts): refuse DNS-rebound
  // Host names and cross-origin browser requests before auth or routing, so
  // a page in the operator's own browser cannot drive a no-keys service.
  fastify.addHook('onRequest', async (request, reply) => {
    const verdict = originGuard.check(request.headers);
    if (!verdict.allowed) {
      return reply.code(403).send({
        error: { code: 'FORBIDDEN', message: verdict.reason, retryable: false },
      });
    }
  });

  // Contract-completeness collector (the MCP generated-catalog pattern
  // applied to the REST surface): record every route so openapi.test.ts can
  // enforce that implemented ⇔ documented bidirectionally. Must be added
  // BEFORE any fastify.register call - child-plugin routes are only seen by
  // an onRoute hook registered at the root beforehand.
  const registeredRoutes: RegisteredRoute[] = [];
  fastify.addHook('onRoute', (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      // Fastify auto-generates HEAD duplicates for GET routes; they carry no
      // contract of their own.
      if (method === 'HEAD') continue;
      registeredRoutes.push({
        method,
        url: routeOptions.url,
        capability: routeOptions.config?.capability,
        ...(routeOptions.config?.publication
          ? { publication: routeOptions.config.publication }
          : {}),
      });
    }
  });
  fastify.decorate('registeredRoutes', registeredRoutes);

  // Fastify's default JSON parser rejects any request whose payload is
  // empty while content-type is application/json (FST_ERR_CTP_EMPTY_JSON_BODY),
  // which turns body-less calls from clients that set the header
  // unconditionally (DELETE /sessions/{id}, POST /pages, ...) into
  // pre-handler 400s. Treat an empty payload as no body; malformed JSON
  // keeps its 400.
  fastify.addContentTypeParser<string>(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      if (body.trim().length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch {
        const parseError: Error & { statusCode?: number } = new Error('Invalid JSON body');
        parseError.statusCode = 400;
        done(parseError, undefined);
      }
    }
  );

  fastify.get('/operator', async (_request, reply) =>
    reply
      .header('Content-Security-Policy', operatorCsp)
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .type('text/html; charset=utf-8')
      .send(operatorHtml)
  );

  // CORS only for operator-allowed origins (AGENTBROWSER_CORS_ORIGINS /
  // options.corsOrigin); none by default — CLI, SDK and MCP clients are not
  // browsers and need no CORS headers.
  await fastify.register(cors, {
    origin: originGuard.corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    preflight: true,
  });

  // WebSocket event streaming (spec 13.1: session events).
  await fastify.register(websocket);

  // Security headers
  fastify.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (request.url.startsWith('/v1/')) reply.header('Cache-Control', 'no-store');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '1; mode=block');
  });

  // The engine is normally injected (bin.ts passes PlaywrightChromiumEngine).
  // The in-memory engine is a development fallback, loaded lazily so
  // production deployments never need the testkit dev dependency.
  let engine = options.engine;
  if (!engine) {
    console.warn(
      '[agentbrowser] No engine injected; using the in-memory FakeEngine. ' +
        'Pass an engine to ServerOptions for real browsing.'
    );
    const { FakeEngine } = await import('@agentbrowser/testkit');
    engine = new FakeEngine();
  }
  const metrics = options.metrics ?? new MetricsRegistry();
  // Trace export (A3): without a tracer, the service emits no spans and
  // the export route would have nothing to serve. In-memory, bounded
  // (RingBuffer), secret-scrubbed via the service's secret manager.
  const tracer =
    options.tracer ??
    new InMemoryTracer({
      ...(options.secretManager ? { secretManager: options.secretManager } : {}),
    });
  const policyLimiter = options.policy;
  const policyIsFile = policyLimiter !== undefined && (policyLimiter.kind ?? 'file') === 'file';
  if (policyIsFile) {
    const conflicts = [
      ...(options.networkPolicy !== undefined ? ['networkPolicy'] : []),
      ...(options.approvalPolicy !== undefined ? ['approvalPolicy'] : []),
      ...(options.extractMaxBytes !== undefined ? ['extractMaxBytes'] : []),
    ];
    const envConflicts = POLICY_BEARING_ENV.filter((name) => process.env[name] !== undefined);
    if (conflicts.length > 0 || envConflicts.length > 0) {
      throw new Error(
        `AGENTBROWSER_POLICY_FILE cannot be combined with ${[...conflicts, ...envConflicts].join(
          ', '
        )}`
      );
    }
  }
  if (policyIsFile) extractMaxBytes = policyLimiter.limits.extractMaxBytes ?? extractMaxBytes;
  // TD-BROWSER-16 phase 4: the login browser. Not a session: no id, no refs,
  // no pages on any agent surface — only the operator routes below touch it.
  const loginBrowser = new LoginBrowserService({
    enabled: options.loginBrowser === true && operatorKeys !== undefined,
  });
  if (options.loginBrowser === true && operatorKeys === undefined) {
    throw new Error(
      'AGENTBROWSER_LOGIN_BROWSER=1 requires AGENTBROWSER_OPERATOR_KEYS_FILE; the login browser is operator-only'
    );
  }

  // TD-15 phase 4: with a policy file, every session's network policy is the
  // floor plus the tenant-bound, per-session-memoized authorizer exceptions.
  // No keys: nothing is bound and the authorizer's implicit Tenant::"local"
  // decides, whatever tenantId a caller claims.
  const sessionPolicyFactory =
    policyLimiter === undefined
      ? undefined
      : sessionPolicyFactoryFor(policyLimiter, apiKeys === undefined, process.env);
  // Validated before the service exists: an invalid ceiling aborts startup.
  const artifactStore = artifactStoreFromEnvironment(process.env);
  // T10 M2: an invalid engagement directory aborts startup; unset refuses scope.ledger.
  const engagement = await engagementConfigFromEnvironment(process.env);
  // T5 J-d: a configured durable journal opens before the service exists, and any refusal to
  // open it aborts startup. Durable work is never served ephemerally: with no open journal it is
  // refused. Unconfigured: nothing changes.
  const journalConfig = await journalConfigFromEnvironment(process.env);
  // A namespace past its accept horizon cannot take new durable work. Refusing startup would take
  // the whole (non-durable) service down with it, so start without the journal instead: durable
  // is then neither advertised nor accepted, and the operator is told to rotate.
  const horizonPassed = journalConfig !== undefined && journalConfig.acceptUntil <= Date.now();
  if (horizonPassed)
    console.warn(
      "[agentbrowser] AGENTBROWSER_JOURNAL_ACCEPT_UNTIL has passed: durable execution is refused; the namespace's records stay readable and recoverable (recover-only) until its retainUntil. Configure a new AGENTBROWSER_JOURNAL_NAMESPACE with a new horizon, listing this one in AGENTBROWSER_JOURNAL_HISTORY_FILE."
    );
  // T5 J3d (D7): namespaces the operator rotated away from, listed with every descriptor input.
  // They open on the SAME store adapter (the store admits one server) and stay searchable and
  // recoverable until retainUntil; they never take a new intent.
  const journalHistory = journalConfig
    ? await journalHistoryFromEnvironment(process.env, journalConfig)
    : [];
  if (!journalConfig && process.env.AGENTBROWSER_JOURNAL_HISTORY_FILE?.trim())
    throw new JournalConfigError(
      'AGENTBROWSER_JOURNAL_HISTORY_FILE requires the durable journal configuration (AGENTBROWSER_JOURNAL_DIR and the rest)'
    );
  // A configured journal always opens its set: the current namespace for durable work while its
  // horizon holds, and recover-only once it has passed (review F1), plus every history namespace.
  const journalSet =
    journalConfig === undefined
      ? undefined
      : await openServiceJournalSet(journalConfig, journalHistory);
  const serviceJournal = journalSet?.journal ? { journal: journalSet.journal } : undefined;
  const historyJournals = (journalSet?.history ?? []).flatMap((state) =>
    state.journal ? [{ namespaceId: state.namespaceId, journal: state.journal }] : []
  );
  // A history namespace the store refused is still configured history: it is UNREAD, never
  // absent, in every lookup and recovery answer.
  const refusedHistory = (journalSet?.history ?? []).flatMap((state) =>
    state.journal ? [] : [state.namespaceId]
  );
  for (const warning of journalHistoryWarnings(journalSet?.history ?? []))
    console.warn(`[agentbrowser] ${warning}`);
  let service: AgentBrowserService;
  try {
    service = new AgentBrowserService({
      ...(serviceJournal !== undefined ? { operationJournal: serviceJournal.journal } : {}),
      ...(historyJournals.length > 0 ? { historyJournals } : {}),
      ...(refusedHistory.length > 0 ? { refusedHistoryNamespaces: refusedHistory } : {}),
      cdpAttachAdmission: attachAdmission,
      extractMaxBytes,
      engine,
      ...(artifactStore !== undefined ? { artifactStore } : {}),
      ...(engagement !== undefined ? { engagement } : {}),
      // TD-BROWSER-16 phase 6: the handoff reads through the login browser
      // (constructed above; enabled encodes operator keys being configured).
      loginBrowser: options.loginBrowserPort ?? loginBrowser,
      ...(options.evidenceReviewProvider !== undefined
        ? { evidenceReviewProvider: options.evidenceReviewProvider }
        : {}),
      ...(options.networkPolicy
        ? { networkPolicy: options.networkPolicy }
        : policyLimiter === undefined &&
            (process.env.AGENTBROWSER_ALLOW_LOOPBACK !== undefined ||
              process.env.AGENTBROWSER_ALLOWED_CIDRS !== undefined ||
              process.env.AGENTBROWSER_MAX_RESPONSE_BYTES !== undefined)
          ? {
              allowLoopback: process.env.AGENTBROWSER_ALLOW_LOOPBACK,
              allowedPrivateCIDRs: process.env.AGENTBROWSER_ALLOWED_CIDRS,
              maxResponseBytes: process.env.AGENTBROWSER_MAX_RESPONSE_BYTES,
            }
          : {}),
      ...(policyLimiter !== undefined
        ? {
            authorizer: policyLimiter.authorizer,
            policyVersion: policyLimiter.version,
            ...(sessionPolicyFactory !== undefined ? { sessionPolicyFactory } : {}),
            ...(apiKeys !== undefined ? { tenantsConfigured: true } : {}),
          }
        : {}),
      ...((options.approvalPolicy ?? process.env.AGENTBROWSER_APPROVAL_POLICY) !== undefined
        ? {
            approvalPolicy:
              options.approvalPolicy ??
              JSON.parse(process.env.AGENTBROWSER_APPROVAL_POLICY ?? '{}'),
          }
        : policyIsFile && policyLimiter?.approval !== undefined
          ? { approvalPolicy: policyLimiter.approval }
          : {}),
      ...(options.engines ? { engines: options.engines } : {}),
      metrics,
      tracer,
      ...(options.secretManager ? { secretManager: options.secretManager } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.downloader ? { downloader: options.downloader } : {}),
      ...(options.defaultTtlMs !== undefined ? { defaultTtlMs: options.defaultTtlMs } : {}),
      ...(options.defaultIdleTimeoutMs !== undefined
        ? { defaultIdleTimeoutMs: options.defaultIdleTimeoutMs }
        : {}),
      ...(options.verifierRegistry ? { verifierRegistry: options.verifierRegistry } : {}),
      ...(options.evidenceSourceRegistry !== undefined
        ? { evidenceSourceRegistry: options.evidenceSourceRegistry }
        : {}),
      ...(options.evidenceSourceRegistryProvider !== undefined
        ? { evidenceSourceRegistryProvider: options.evidenceSourceRegistryProvider }
        : {}),
      ...(options.applicationAdapters ? { applicationAdapters: options.applicationAdapters } : {}),
    });
  } catch (error) {
    // A service that never existed cannot close the journal it was given.
    await journalSet?.close();
    throw error;
  }

  fastify.addHook('onClose', async () => {
    try {
      await service.shutdown();
    } finally {
      // The journal outlives every session's terminal write; closed last.
      await journalSet?.close();
    }
  });

  /**
   * Invoke caller serialization once, then redact detached data. Contain both
   * phases and detach the result so reply serialization invokes no callbacks.
   */
  const serialDetails = (details: unknown): unknown => {
    try {
      const serialized = JSON.stringify(details);
      if (serialized === undefined) return undefined;
      const detached: unknown = JSON.parse(serialized);
      const safe = options.secretManager?.redact(detached) ?? detached;
      return JSON.parse(JSON.stringify(safe));
    } catch {
      return undefined;
    }
  };

  const errorResponse = (error: unknown): HttpResponseDraft => {
    if (error instanceof ControlError || error instanceof ServiceError) {
      const details =
        error instanceof ServiceError && error.details !== undefined
          ? serialDetails(error.details)
          : undefined;
      return responseDraft(
        {
          error: {
            code: error.code,
            message: options.secretManager?.redact(error.message) ?? error.message,
            retryable: error instanceof ServiceError ? error.retryable : false,
            ...(details !== undefined ? { details } : {}),
          },
        },
        statusFor(error.code)
      );
    }
    // Internal faults never echo error text to the client: redact() only
    // substitutes registered values. Keep unregistered text out of both
    // the client response and the server-side sink.
    try {
      options.logger?.error('http.framework_error', {
        code: 'INTERNAL',
        status: 500,
      });
    } catch {
      // Logging must not replace the safe response with a sink's private diagnostic.
    }
    return responseDraft(
      {
        error: {
          code: 'INTERNAL',
          message: 'An unexpected error occurred',
          retryable: false,
        },
      },
      500
    );
  };
  const fail = (reply: FastifyReply, error: unknown) => {
    const draft = errorResponse(error);
    return reply.code(draft.statusCode).send(draft.body);
  };

  function requireBody(body: unknown): asserts body is Record<string, unknown> {
    if (body === undefined || body === null || typeof body !== 'object')
      throw new ServiceError('INVALID_REQUEST', 'A JSON request body is required');
  }

  /**
   * Wrap a /v1 handler with the try/catch -> fail(reply, error) frame every
   * route below needed (hygiene F1). A pure mechanical extraction - no
   * handler body logic changes, only the duplicated shell is removed. Grew
   * to 22 identical copies (from 16 at the last audit) as new routes kept
   * repeating the pattern instead of using an abstraction.
   */
  const httpPublication = createHttpPublication();
  const principals = new WeakMap<FastifyRequest, SessionPrincipal>();
  const terminalFailure = (
    request: FastifyRequest,
    sessionId: string,
    error: unknown = new ServiceError('SESSION_NOT_FOUND', 'Session does not exist.')
  ): unknown => {
    const terminal = service.inspectTerminalSession(sessionId);
    if (!terminal) return error;
    const principal = principals.get(request);
    // A removed delegated grant never regains disclosure authority. Requests
    // that reach here are either independently authenticated operators or the
    // established no-key local mode.
    if (principal?.actor === 'agent') return error;
    const tenant = (request as FastifyRequest & { tenant?: string }).tenant;
    if (tenant !== undefined && terminal.ownerTenant !== tenant) return error;
    // A transition may race an admitted handler failure. Terminal publication
    // is a fresh static envelope and never carries arbitrary prior details.
    return new ServiceError('SESSION_NOT_FOUND', 'Session does not exist.', false, {
      sessionTerminal: terminal.view,
    });
  };
  const responseStatus = (statusCode: number, body: unknown) => responseDraft(body, statusCode);
  const executionResponse = <T extends { ok: boolean } | { status: 'success' | 'failed' }>(
    result: T
  ) =>
    responseDraft(result, 200, {
      executionFailed: 'ok' in result ? !result.ok : result.status === 'failed',
    });
  const outcomeResponse = (result: Awaited<ReturnType<AgentBrowserService['executeOutcome']>>) =>
    responseDraft(result, 200, { executionFailed: result.outcome.execution !== 'completed' });

  /** Shared error/tenant boundary; `on` admits drafts, `onTransport` owns explicit lifecycle/self admission. */
  const route =
    (
      handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
      publishTerminal = true
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { sessionId } = request.params as { sessionId?: string };
        if (publishTerminal && sessionId && service.inspectTerminalSession(sessionId)) {
          throw terminalFailure(request, sessionId);
        }
        const control = sessionId ? service.authority.get(sessionId) : undefined;
        if (!sessionId || !control) return await handler(request, reply);
        const principal = principals.get(request);
        const session = service.getSession(sessionId);
        if (
          !principal ||
          !session ||
          session.tenantId !== principal.tenant ||
          (principal.actor === 'agent' && principal.sessionId !== sessionId)
        )
          throw new ServiceError('FORBIDDEN', 'Session authority does not match');
        return await handler(request, reply);
      } catch (error) {
        if (reply.raw.destroyed) return reply.hijack();
        if (reply.sent) return reply;
        const { sessionId } = request.params as { sessionId?: string };
        return fail(
          reply,
          publishTerminal && sessionId ? terminalFailure(request, sessionId, error) : error
        );
      }
    };

  /**
   * Extract typed path params without re-declaring the shape at each call
   * site (hygiene F2, grew to 21 copies). Fastify guarantees a matched
   * route's named segments are present strings, so this never defaults -
   * the `= ''` defaults two call sites previously carried were dead code
   * for exactly that reason.
   */
  const params = <K extends string>(
    request: Pick<FastifyRequest, 'params'>,
    ...keys: K[]
  ): Record<K, string> => {
    const raw = request.params as Record<string, string>;
    return Object.fromEntries(keys.map((k) => [k, raw[k]])) as Record<K, string>;
  };

  fastify.get('/health/live', async (request, reply) => {
    return { status: 'live', timestamp: new Date().toISOString() };
  });

  if (apiKeys === undefined || apiKeys.size === 0) {
    console.warn(
      '[agentbrowser] No API keys configured; /v1 is UNAUTHENTICATED. ' +
        'Set AGENTBROWSER_API_KEYS=key:tenant[,key:tenant...] for multi-tenant use.'
    );
  }

  /** Bearer check for infra planes; undefined tenant when unauthenticated. */
  const infraTenantOf = (request: FastifyRequest): string | undefined => {
    if (apiKeys === undefined || apiKeys.size === 0) {
      return undefined; // no-keys local mode: everything open, loudly warned
    }
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    return token.length > 0 ? apiKeys.get(sha256Hex(token)) : undefined;
  };

  fastify.get('/health/ready', async (request, reply) => {
    try {
      // Unauthenticated probes get a minimal, disclosure-free answer.
      const tenant = infraTenantOf(request);
      if (tenant === undefined && apiKeys !== undefined && apiKeys.size > 0) {
        return {
          status: await engine.capabilities().then(
            () => 'ready',
            () => 'unavailable'
          ),
        };
      }
      const capabilities = await engine.capabilities();
      return { status: 'ready', engine: engine.name, version: engine.version, capabilities };
    } catch {
      // Unauthenticated infra route: state only, never the engine's raw
      // error text (driver paths, topology, stack-adjacent detail).
      return reply.status(503).send({
        error: {
          code: 'ENGINE_CRASHED',
          message: 'Engine is not responding',
          retryable: true,
        },
      });
    }
  });

  // Metrics are operational data: authenticated when keys are configured.
  fastify.get('/metrics', async (request, reply) => {
    if (infraTenantOf(request) === undefined && apiKeys !== undefined && apiKeys.size > 0) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'A valid Authorization: Bearer <apiKey> header is required.',
          retryable: false,
        },
      });
    }
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render());
  });

  fastify.get('/health', async (request, reply) => {
    return {
      status: 'healthy',
      version: PRODUCT_VERSION,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      // TD-15 phase 4: the authorizer's health as a boolean only — no ids,
      // no reasons, no policy content.
      ...(policyLimiter !== undefined
        ? {
            authorizerHealthy:
              policyLimiter.authorizer.shadowHealthy ?? policyLimiter.authorizer.healthy ?? true,
          }
        : {}),
    };
  });

  const openApiDocument = buildOpenApiDocument();
  fastify.get('/openapi.json', async (_request, reply) => {
    return reply.type('application/json').send(openApiDocument);
  });

  // ------------------------------------------------------------------
  // /v1 resource routes: versioned per spec 13.1, authenticated when API
  // keys are configured. Infra planes (health/metrics/openapi) stay
  // unversioned and unauthenticated by design.
  // ------------------------------------------------------------------
  const artifactAuth = new ArtifactAuthorizer({
    key: process.env.AGENTBROWSER_ARTIFACT_KEY ?? randomBytes(32).toString('hex'),
  });

  await fastify.register(
    async (v1) => {
      v1.addHook('onRequest', async (request, reply) => {
        const header = request.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        const tenant = token ? apiKeys?.get(sha256Hex(token)) : undefined;
        if (tenant !== undefined) {
          principals.set(request, { actor: 'operator', tenant });
          (request as FastifyRequest & { tenant?: string }).tenant = tenant;
          return;
        }
        // TD-BROWSER-16 phase 1: an operator key authenticates a human
        // operator — and only on operator-flagged routes; anywhere else it is
        // refused, so a leaked operator key cannot drive sessions.
        const operatorTenant = token ? operatorKeys?.byHash.get(sha256Hex(token)) : undefined;
        if (operatorTenant !== undefined) {
          if (request.routeOptions.config?.operatorRoute !== true) {
            return reply.code(403).send({
              error: {
                code: 'FORBIDDEN',
                message: 'Operator keys are not valid on this route',
                retryable: false,
              },
            });
          }
          principals.set(request, { actor: 'human-operator', tenant: operatorTenant });
          (request as FastifyRequest & { tenant?: string }).tenant = operatorTenant;
          return;
        }
        const agent = token ? service.authority.authenticate(token) : undefined;
        if (agent) {
          // Expiry is checked against the coordinator before trusting the grant.
          if (!service.getSession(agent.sessionId))
            return reply.code(401).send({
              error: { code: 'UNAUTHORIZED', message: 'Session expired', retryable: false },
            });
          const sameSession =
            (request.params as { sessionId?: string }).sessionId === agent.sessionId;
          const capability = request.routeOptions.config?.capability;
          if (!sameSession || !capability || !agentModeAllows(agent.mode, capability))
            return reply.code(403).send({
              error: {
                code: 'FORBIDDEN',
                message: 'Delegated credential profile does not permit this operation',
                retryable: false,
              },
            });
          principals.set(request, agent);
          (request as FastifyRequest & { tenant?: string }).tenant = agent.tenant;
          return;
        }
        if ((apiKeys?.size ?? 0) > 0 || token)
          return reply.code(401).send({
            error: {
              code: 'UNAUTHORIZED',
              message: 'A valid bearer credential is required',
              retryable: false,
            },
          });
      });

      const tenantOf = (request: FastifyRequest | RequestData): string | undefined =>
        (request as FastifyRequest & { tenant?: string }).tenant;

      // ------------------------------------------------------------------
      // T5 J3b (accepted J-design, D1 amended + D5): read-only journal
      // surfaces. Readable by a tenant API key or the operator key,
      // tenant-scoped; delegated agent grants are refused (no session-bound
      // route), and writes do not exist here (J3c, operator-only). Keyless
      // deployments have no surface: no credential names a tenant.
      // ------------------------------------------------------------------
      const journalLimiter = new TokenBucketLimiter({
        capacity: 30,
        refillPerInterval: 30,
        intervalMs: 60_000,
        maxTenants: 4096,
      });
      const journalRefusal = (
        reply: FastifyReply,
        code: string,
        message: string,
        status: number,
        retryable = false
      ) => reply.code(status).send({ error: { code, message, retryable } });

      /** The journal plane's shared admission: an authenticated principal, plus a
       * rate-limit slot for the lookup routes. Sends the typed refusal and returns
       * undefined when the route must not proceed. */
      const requireJournalPrincipal = (
        request: FastifyRequest,
        reply: FastifyReply,
        limiter = false
      ) => {
        const principal = principals.get(request);
        if (!principal) {
          journalRefusal(reply, 'UNAUTHORIZED', 'A valid bearer credential is required', 401);
          return undefined;
        }
        if (limiter && !journalLimiter.take(principal.tenant)) {
          journalRefusal(reply, 'RATE_LIMITED', 'Journal lookup rate limit exceeded', 429, true);
          return undefined;
        }
        return principal;
      };

      // T10 M2: export one of the caller's engagement ledgers as NDJSON (the
      // file, verbatim, so it verifies offline). Same credential rule as the
      // journal: a tenant API key or the operator key; keyless deployments have
      // no surface (no credential names a tenant).
      v1.get(
        '/engagements/:engagementId',
        { config: { operatorRoute: true, publication: 'lifecycle' } },
        async (request, reply) => {
          const principal = principals.get(request);
          if (!principal)
            return reply.code(401).send({
              error: {
                code: 'UNAUTHORIZED',
                message: 'A valid bearer credential is required',
                retryable: false,
              },
            });
          if (principal.tenant === undefined)
            return reply.code(403).send({
              error: {
                code: 'FORBIDDEN',
                message: 'Engagement export needs a credential that names a tenant',
                retryable: false,
              },
            });
          const { engagementId } = request.params as { engagementId: string };
          const file = await service.engagementLedgerFile(principal.tenant, engagementId);
          return reply
            .header('content-type', 'application/x-ndjson')
            .header('content-length', String(file.bytes))
            .send(createReadStream(file.path, { start: 0, end: Math.max(0, file.bytes - 1) }));
        }
      );

      v1.get(
        '/journal',
        { config: { operatorRoute: true, publication: 'lifecycle' } },
        async (request, reply) => {
          const principal = requireJournalPrincipal(request, reply, true);
          if (!principal) return;
          const acceptUntil = journalConfig
            ? new Date(journalConfig.acceptUntil).toISOString()
            : undefined;
          const retainUntil = journalConfig
            ? new Date(journalConfig.acceptUntil + SERVICE_JOURNAL_RETAIN_MS).toISOString()
            : undefined;
          const health = serviceJournal?.journal.health;
          const qualified = journalRuntimeQualified();
          return {
            schemaVersion: 1 as const,
            configured: journalConfig !== undefined,
            ...(journalConfig ? { namespace: journalConfig.namespaceId } : {}),
            ...(health !== undefined ? { health } : {}),
            ...(acceptUntil !== undefined ? { acceptUntil } : {}),
            ...(retainUntil !== undefined ? { retainUntil } : {}),
            runtime: {
              platform: process.platform,
              node: process.versions.node,
              qualified,
            },
            recoveryQualified: qualified && health === 'open',
            ...(journalSet && journalSet.history.length > 0
              ? {
                  history: journalSet.history.map((state) => ({
                    namespace: state.namespaceId,
                    ...(state.current ? { current: true as const } : {}),
                    // A refused namespace stays refused for this process; an opened one reports
                    // open while its handle is healthy.
                    state:
                      state.journal === undefined
                        ? ('refused' as const)
                        : state.journal.health === 'open'
                          ? ('open' as const)
                          : ('unavailable' as const),
                    ...(state.refusal !== undefined
                      ? { reason: state.refusal }
                      : state.journal !== undefined && state.journal.health !== 'open'
                        ? { reason: state.journal.health }
                        : {}),
                    acceptUntil: new Date(state.acceptUntil).toISOString(),
                    retainUntil: new Date(state.retainUntil).toISOString(),
                  })),
                }
              : {}),
          };
        }
      );

      v1.get(
        '/journal/operations/:operationId',
        { config: { operatorRoute: true, publication: 'lifecycle' } },
        async (request, reply) => {
          const principal = requireJournalPrincipal(request, reply, true);
          if (!principal) return;
          const { operationId } = request.params as { operationId: string };
          if (!CONTROL_OPERATION_ID.test(operationId))
            return journalRefusal(reply, 'INVALID_REQUEST', 'Invalid operation ID', 400);
          // J3d: the current namespace (when open) and every open history namespace are searched.
          const searched = [
            ...(serviceJournal ? [serviceJournal.journal] : []),
            ...historyJournals.map((entry) => entry.journal),
          ];
          if (searched.length === 0) {
            if (journalConfig)
              // Configured but not open (for example a passed accept horizon): records may exist
              // and be unreachable — history is unread, not absent.
              return journalRefusal(
                reply,
                'JOURNAL_UNAVAILABLE',
                'The journal is configured but not open on this deployment; history is unread, not absent',
                503,
                true
              );
            return journalRefusal(
              reply,
              'JOURNAL_NOT_CONFIGURED',
              'No durable journal is configured on this deployment',
              404
            );
          }
          const tenant = principal.tenant;
          // Keyless deployments authenticate nobody; a credential without a tenant scopes nothing.
          if (tenant === undefined)
            return journalRefusal(
              reply,
              'FORBIDDEN',
              'Journal history is tenant-scoped; this credential names no tenant',
              403
            );
          const search = await searchJournalNamespaces(searched, { tenantId: tenant, operationId });
          const { entries, truncated, lastReason } = search;
          const unreadNamespaces = [...search.unreadNamespaces, ...refusedHistory];
          // Nothing could be read at all: the whole answer is unread, not absent.
          if (search.unreadNamespaces.length === searched.length)
            return journalRefusal(
              reply,
              'JOURNAL_UNAVAILABLE',
              `The journal refused this lookup (${lastReason}); treat the history as unread, not absent`,
              503,
              true
            );
          const found = entries.map((entry) => entry.record);
          // Projection: only derived classification, application identity and the departed
          // session's opaque identity cross the wire. Fingerprints, digests, actors, inputs and
          // evidence content never do.
          const records = found.map((record) => ({
            namespace: record.namespaceId,
            ...classifyJournalRecord(record),
            application: {
              adapter: record.identity.application?.adapterId ?? '',
              resource: record.identity.application?.resourceId ?? '',
              bindingGeneration: record.identity.application?.bindingGeneration ?? '',
            },
            session: {
              sessionIncarnation: record.identity.key.sessionIncarnation,
              epoch: record.identity.key.epoch,
            },
          }));
          return {
            schemaVersion: 1 as const,
            operationId,
            // Absence is claimed only when EVERY searched namespace answered.
            absent: records.length === 0 && !truncated && unreadNamespaces.length === 0,
            truncated,
            ...(unreadNamespaces.length > 0 ? { unreadNamespaces } : {}),
            records,
          };
        }
      );

      // ------------------------------------------------------------------
      // TD-BROWSER-15 phase 5: the policy query surface. Answers by
      // enumeration, never by resolution; bounded per tenant.
      // ------------------------------------------------------------------
      const CHECK_ACTIONS = new Set([
        'request',
        'request.loopback',
        'request.private',
        'act',
        'act.unattended',
        'cdp.attach',
        'downloads',
        'serviceWorkers',
        'cookie.seed',
        'cookie.export',
        'session.headed',
        // TD-BROWSER-16 phase 7: the per-domain handoff question — the
        // domain rides `target` (never resolved; the engine branch refuses
        // bare suffixes exactly as the handoff floor does).
        'cookie.handoff',
      ]);
      const queryLimiter = new TokenBucketLimiter({
        capacity: 30,
        refillPerInterval: 30,
        intervalMs: 60_000,
        maxTenants: 4096,
      });
      const rateLimited = (request: FastifyRequest, reply: FastifyReply): boolean => {
        if (queryLimiter.take(tenantOf(request))) return false;
        reply.status(429).send({
          error: {
            code: 'RATE_LIMITED',
            message: 'Policy query rate limit exceeded',
            retryable: true,
          },
        });
        return true;
      };

      // ------------------------------------------------------------------
      // T5 J3c part 1: the operator-only recovery WRITES (D2 close, D3 settle),
      // sharing J3b's journal refusal helper and rate limiter.
      // ------------------------------------------------------------------
      // Recovery writes keep their OWN per-tenant bucket: a tenant API key's reads share the
      // tenant with the operator in single-tenant deployments, and the credential class that may
      // never write must not starve the only one that may.
      const recoveryLimiter = new TokenBucketLimiter({
        capacity: 30,
        refillPerInterval: 30,
        intervalMs: 60_000,
        maxTenants: 4096,
      });
      const recoveryWrite = (request: FastifyRequest, reply: FastifyReply) => {
        const principal = requireJournalPrincipal(request, reply);
        if (!principal) return;
        // D1 as amended: writes are the ADR-025 operator principal only. A tenant API key
        // authenticates as actor 'operator' and the /v1 hook admits it on any route; the
        // service refuses it — the accepted design's named implementation hazard.
        if (principal.actor !== 'human-operator')
          return journalRefusal(
            reply,
            'FORBIDDEN',
            'Journal recovery writes require the operator key; a tenant API key may only read',
            403
          );
        if (!recoveryLimiter.take(principal.tenant))
          return journalRefusal(
            reply,
            'RATE_LIMITED',
            'Journal recovery rate limit exceeded',
            429,
            true
          );
        return undefined;
      };
      const recoveryOperation = async (
        request: FastifyRequest,
        reply: FastifyReply,
        run: () => Promise<{ closed?: number; settled?: number; reconciled?: number }>
      ) => {
        if (recoveryWrite(request, reply)) return reply;
        const { operationId } = request.params as { operationId: string };
        if (!CONTROL_OPERATION_ID.test(operationId))
          return journalRefusal(reply, 'INVALID_REQUEST', 'Invalid operation ID', 400);
        try {
          return await run();
        } catch (error) {
          const code = (error as { code?: string }).code;
          // CONTROL_REQUIRED here is a state precondition (the adapter cannot reconcile), not an
          // authorization failure, so it answers 409 like the other recovery conflicts.
          const status =
            code === 'NOT_FOUND'
              ? 404
              : code === 'OPERATION_CONFLICT' || code === 'CONTROL_REQUIRED'
                ? 409
                : 503;
          if (status !== 503 || code === 'JOURNAL_UNAVAILABLE')
            return journalRefusal(
              reply,
              code ?? 'INTERNAL',
              (error as Error).message,
              status,
              status === 503
            );
          throw error;
        }
      };

      v1.post(
        '/journal/operations/:operationId/close',
        { config: { operatorRoute: true, publication: 'lifecycle' } },
        async (request, reply) =>
          recoveryOperation(request, reply, () =>
            service.journalCloseOperation(
              (request.params as { operationId: string }).operationId,
              principals.get(request) as { actor: string; tenant: string }
            )
          )
      );

      v1.post(
        '/journal/operations/:operationId/settle',
        { config: { operatorRoute: true, publication: 'lifecycle' } },
        async (request, reply) =>
          recoveryOperation(request, reply, () =>
            service.journalSettleOperation(
              (request.params as { operationId: string }).operationId,
              principals.get(request) as { actor: string; tenant: string }
            )
          )
      );

      // T5 J3c part 2 (D3): ask the bound adapter what truly happened to in-doubt records.
      v1.post(
        '/journal/operations/:operationId/reconcile',
        { config: { operatorRoute: true, publication: 'lifecycle' } },
        async (request, reply) =>
          recoveryOperation(request, reply, () =>
            service.journalReconcileOperation(
              (request.params as { operationId: string }).operationId,
              principals.get(request) as { actor: string; tenant: string }
            )
          )
      );

      v1.get('/policy', { config: { publication: 'lifecycle' } }, async (request, reply) => {
        if (rateLimited(request, reply)) return reply;
        return {
          policyVersion: policyLimiter?.version ?? 'legacy',
          limits: policyLimiter?.limits ?? {},
          summaryFor: "a default session of the caller's tenant",
          capabilities: service.policyCapabilitySummary(tenantOf(request)),
          ...(policyIsFile
            ? {}
            : {
                unconditional:
                  'no policy file is loaded; these answers are unconditional for a default session',
              }),
        };
      });

      // TD-BROWSER-16 phase 4: the login browser's operator routes. Human
      // operators only (operatorRoute); agent credentials and API-key
      // operators are refused by the checks inside each handler.
      const requireHumanOperator = (request: FastifyRequest): void => {
        if (principals.get(request)?.actor !== 'human-operator')
          throw new ServiceError(...FLOOR_OPERATOR_REQUIRED);
      };
      const requireLoginBrowser = (): LoginBrowserService => {
        if (!loginBrowser.isEnabled)
          throw new ServiceError(
            'INVALID_REQUEST',
            'the login browser is disabled; set AGENTBROWSER_LOGIN_BROWSER=1 with operator keys configured',
            false
          );
        return loginBrowser;
      };
      /**
       * Engine refusals must stay typed at the client, not become 500s. A
       * non-LoginBrowserError (e.g. Playwright's ProcessSingleton failure on
       * a hand-started Chrome) is the in-use refusal the ADR names.
       */
      const loginBrowserServiceError = (error: unknown): ServiceError =>
        error instanceof LoginBrowserError
          ? new ServiceError(error.code, error.message, false, {
              loginBrowser: error.code,
            })
          : new ServiceError(
              'LOGIN_PROFILE_IN_USE',
              'the login profile is in use or the browser did not start',
              false
            );

      v1.post(
        '/operator/login/open',
        { config: { publication: 'lifecycle', operatorRoute: true } },
        async (request) => {
          requireHumanOperator(request);
          requireLoginBrowser();
          // ADR-025 §1: headed, single-tenant, non-hosted deployments only.
          // (True multi-tenant deployments never boot with operator keys.)
          if (deploymentMode === 'hosted')
            throw new ServiceError(
              'INVALID_REQUEST',
              'the login browser is not available on hosted deployments',
              false
            );
          try {
            return await loginBrowser.open();
          } catch (error) {
            throw error instanceof ServiceError ? error : loginBrowserServiceError(error);
          }
        }
      );

      v1.post(
        '/operator/login/close',
        { config: { publication: 'lifecycle', operatorRoute: true } },
        async (request) => {
          requireHumanOperator(request);
          requireLoginBrowser();
          try {
            return await loginBrowser.close();
          } catch (error) {
            throw loginBrowserServiceError(error);
          }
        }
      );

      v1.post(
        '/operator/login/reset',
        { config: { publication: 'lifecycle', operatorRoute: true } },
        async (request) => {
          requireHumanOperator(request);
          requireLoginBrowser();
          try {
            return await loginBrowser.reset();
          } catch (error) {
            throw loginBrowserServiceError(error);
          }
        }
      );

      v1.post(
        '/operator/login/read',
        { config: { publication: 'lifecycle', operatorRoute: true } },
        async (request) => {
          requireHumanOperator(request);
          requireLoginBrowser();
          try {
            const result = await loginBrowser.read();
            // The bounds are checked first (TD phase 4): an over-count read
            // refuses rather than truncating silently.
            if (result.cookies.length > MAX_COOKIE_COUNT)
              throw new ServiceError(
                'INVALID_REQUEST',
                `the login browser holds more than ${MAX_COOKIE_COUNT} cookies; reset the profile`,
                false
              );
            return result;
          } catch (error) {
            throw error instanceof ServiceError ? error : loginBrowserServiceError(error);
          }
        }
      );

      v1.post('/policy/check', { config: { publication: 'lifecycle' } }, async (request, reply) => {
        if (rateLimited(request, reply)) return reply;
        const body = request.body as
          | {
              action?: unknown;
              target?: unknown;
              url?: unknown;
              context?: unknown;
              tenantId?: unknown;
            }
          | undefined;
        const action = typeof body?.action === 'string' ? body.action : undefined;
        if (action === undefined || !CHECK_ACTIONS.has(action)) {
          return reply.status(400).send({
            error: {
              code: 'INVALID_REQUEST',
              message: 'action must be a known action name',
              retryable: false,
            },
          });
        }
        let target = typeof body?.target === 'string' ? body.target : undefined;
        if (target === undefined && typeof body?.url === 'string') {
          try {
            target = new URL(body.url).hostname;
          } catch {
            return reply.status(400).send({
              error: {
                code: 'INVALID_REQUEST',
                message: 'url must be a valid URL',
                retryable: false,
              },
            });
          }
        }
        // A caller cannot smuggle a tenant: the authenticated tenant decides.
        const context =
          body?.context !== null && typeof body?.context === 'object'
            ? (body.context as { effect?: unknown; matchedRule?: unknown })
            : {};
        return {
          action,
          ...(target !== undefined ? { target } : {}),
          answers: service.policyCheck({
            action: action as never,
            ...(target !== undefined ? { target } : {}),
            context: {
              ...(typeof context.effect === 'string' ? { effect: context.effect } : {}),
              ...(typeof context.matchedRule === 'string'
                ? { matchedRule: context.matchedRule }
                : {}),
            },
            ...(() => {
              const tenant = tenantOf(request);
              return tenant !== undefined ? { tenantId: tenant } : {};
            })(),
          }),
        };
      });

      /** 403 unless the session belongs to the caller's tenant. */
      const requireOwnership = (sessionId: string, tenant: string | undefined): void => {
        if (tenant === undefined) return;
        const session = service.getSession(sessionId);
        if (session === undefined) {
          const terminal = service.inspectTerminalSession(sessionId);
          if (terminal?.ownerTenant === tenant) return;
          throw new ServiceError('SESSION_NOT_FOUND', 'Session does not exist.');
        }
        // Fail closed: an authenticated tenant never reaches an ownerless
        // session. (Agent credentials need operator authority, i.e. keys, so
        // every delegated session is tenant-stamped.)
        if (session.tenantId !== tenant)
          throw new ServiceError('FORBIDDEN', `Session ${sessionId} belongs to another tenant.`);
      };

      /**
       * One definition site per route: the handler wrapper (route) and the
       * delegated capability ride the same registration. The capability is
       * exposed through fastify route config so the delegated-token hook
       * reads it; routes registered without one are simply not reachable by
       * delegated grants (403), exactly as the previous capability table
       * produced.
       */
      type RequestData = Readonly<
        Pick<FastifyRequest, 'method' | 'url' | 'headers' | 'body' | 'params' | 'query'> & {
          tenant?: string;
          principal?: SessionPrincipal;
        }
      >;
      const requestData = (request: FastifyRequest): RequestData => {
        const tenant = tenantOf(request);
        const principal = principals.get(request);
        return Object.freeze({
          method: request.method,
          url: request.url,
          headers: Object.freeze({ ...request.headers }),
          body: request.body,
          params: request.params,
          query: request.query,
          ...(tenant !== undefined ? { tenant } : {}),
          ...(principal ? { principal } : {}),
        });
      };
      type RouteMeta = {
        capability?: AgentCapability;
        safe?: boolean;
        terminal?: 'retained-resource';
        /** TD-BROWSER-16 phase 1: human-operator keys are valid here and only here. */
        operatorRoute?: boolean;
        /**
         * T5 B-dur (B1): this route accepts `executionRequirement`; `durable` journals it as ONE
         * browser operation of this kind under the reserved `browser` identity.
         */
        browserDurable?: 'act' | 'plan' | 'autofill';
      };
      const onTransport = (
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        url: string,
        handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
        meta: RouteMeta & { publication?: 'guarded' | 'when-controlled' } = {}
      ) =>
        v1.route({
          method,
          url,
          config: {
            ...(meta.capability ? { capability: meta.capability } : {}),
            ...(meta.operatorRoute ? { operatorRoute: true } : {}),
            publication: meta.publication ?? 'lifecycle',
          },
          ...(meta.publication
            ? { onSend: httpPublication.onSend, onError: httpPublication.onError }
            : {}),
          handler: route(handler, meta.terminal !== 'retained-resource'),
        });

      // Work receives no Fastify reply: only the publisher can serialize/send.
      const on = (
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        url: string,
        handler: (request: RequestData) => Promise<HttpResponseDraft>,
        meta: RouteMeta = {}
      ) =>
        onTransport(
          method,
          url,
          async (request, reply) => {
            const { sessionId, pageId } = request.params as { sessionId?: string; pageId?: string };
            // T5 B-dur (B1): peel the execution requirement off a browser route's body before the
            // handler validates it. 'ephemeral' is the default made explicit and is dropped, so
            // explicit and omitted requests share one identity; 'durable' journals the operation.
            let durable = false;
            // No silent fallback: a route that cannot journal must not quietly accept the field.
            if (
              !meta.browserDurable &&
              request.body &&
              typeof request.body === 'object' &&
              Object.hasOwn(request.body, 'executionRequirement')
            )
              throw new ServiceError(
                'INVALID_REQUEST',
                'executionRequirement is accepted only on act, plan and autofill (and application execute)'
              );
            if (meta.browserDurable && request.body && typeof request.body === 'object') {
              const body = request.body as Record<string, unknown>;
              if (Object.hasOwn(body, 'executionRequirement')) {
                const requirement = body.executionRequirement;
                if (requirement !== 'ephemeral' && requirement !== 'durable')
                  throw new ServiceError(
                    'INVALID_REQUEST',
                    "executionRequirement must be 'ephemeral' or 'durable'"
                  );
                durable = requirement === 'durable';
                const { executionRequirement: _peeled, ...rest } = body;
                request.body = rest;
              }
            }
            const input = requestData(request);
            if (!sessionId || !service.authority.get(sessionId)) {
              if (sessionId && service.requiresSessionAuthority(sessionId))
                throw new ServiceError('CONTROL_REVOKED', 'Session authority is unavailable');
              if (durable)
                throw new ServiceError(
                  'CONTROL_REQUIRED',
                  'Durable browser operations require a controlled session (an operation scope and X-AgentBrowser-Operation-Id)',
                  false
                );
              return httpPublication.sendUncontrolled(request, reply, await handler(input));
            }
            const principal = principals.get(request);
            if (!principal) throw new ServiceError('FORBIDDEN', 'Session authority does not match');
            const mutation =
              request.method === 'DELETE' || (request.method === 'POST' && meta.safe !== true);
            const id = request.headers['x-agentbrowser-operation-id'];
            if (mutation && (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)))
              throw new ServiceError(
                'INVALID_REQUEST',
                'Controlled writes require X-AgentBrowser-Operation-Id (1-128 letters, digits, _ or -)'
              );
            return httpPublication.respond(request, reply, async (output) => {
              let draft: HttpResponseDraft | undefined;
              let thrownOutcomeUnknown = false;
              await service.authority.run(
                sessionId,
                principal,
                mutation
                  ? {
                      id: id as string,
                      // A durable request is its own identity: it can never replay an ephemeral
                      // one, and an explicit 'ephemeral' was already peeled (same as omitted).
                      fingerprint: sha256Hex(
                        JSON.stringify([
                          request.method,
                          request.url,
                          request.body ?? null,
                          ...(durable ? ['durable'] : []),
                        ])
                      ),
                      ...(durable && meta.browserDurable
                        ? {
                            journal: {
                              version: 1 as const,
                              application: {
                                adapterId: RESERVED_BROWSER_ADAPTER_ID,
                                resourceId: meta.browserDurable,
                                bindingGeneration: pageId ?? 'session',
                              },
                              durable: true as const,
                              browser: true as const,
                            },
                          }
                        : {}),
                    }
                  : {},
                async () => {
                  try {
                    draft = await handler(input);
                  } catch (error) {
                    // T5 B-dur (B2): judged on the error object itself (a post-effect failure is
                    // marked there), before it is serialized into a response.
                    thrownOutcomeUnknown = browserFailureOutcomeUnknown(error);
                    // Admitted errors may carry private approval details; publish with the same owner.
                    draft = errorResponse(error);
                  }
                  return draft;
                },
                () => {
                  if (!draft) return true;
                  const failedDraft = draft.statusCode >= 400 || draft.executionFailed === true;
                  if (!durable || !failedDraft) return failedDraft;
                  // T5 B-dur (B2): a durable browser operation's KNOWN failure (its own report, a
                  // typed refusal) is a terminal `failed` with the response returned; a failure
                  // whose effect is genuinely unknown — an error code that loses the result, or a
                  // report hiding such a step or an `uncertain` receipt — stays in doubt.
                  if (draft.statusCode < 400)
                    return browserReportOutcomeUnknown(draft.body) ? true : 'rejected';
                  return thrownOutcomeUnknown ||
                    browserFailureOutcomeUnknown(
                      (draft.body as { error?: unknown } | undefined)?.error
                    )
                    ? true
                    : 'rejected';
                },
                output.draftPublication(),
                output.publication((operation) => ({ replay: true, operation }))
              );
            });
          },
          { ...meta, publication: 'when-controlled' }
        );

      // Session management endpoints
      onTransport('POST', '/sessions', async (request, reply) => {
        const body = request.body;
        requireBody(body);

        if (body.controlMode === 'delegated' && principals.get(request)?.actor !== 'operator')
          throw new ServiceError(...FLOOR_DELEGATED_REQUIRES_OPERATOR);
        const authenticatedTenant = tenantOf(request);
        if (authenticatedTenant !== undefined) {
          // With keys configured, the key's tenant wins; a mismatching body
          // tenant is a cross-tenant attempt.
          const bodyTenant = (body as Record<string, unknown>).tenantId;
          if (bodyTenant !== undefined && bodyTenant !== authenticatedTenant) {
            return reply.status(403).send({
              error: {
                code: 'FORBIDDEN',
                message: `API key belongs to tenant ${authenticatedTenant}.`,
                retryable: false,
              },
            });
          }
          (body as Record<string, unknown>).tenantId = authenticatedTenant;
        } else if (typeof (body as Record<string, unknown>).tenantId !== 'string') {
          return reply.status(400).send({
            error: { code: 'INVALID_REQUEST', message: 'tenantId is required', retryable: false },
          });
        }

        if ('cdpEndpoint' in (body as object) || 'operatorCdp' in (body as object))
          throw new ServiceError(
            'INVALID_REQUEST',
            'CDP endpoints are trusted startup configuration, never session input.'
          );
        // TD-BROWSER-16 (ADR-025 §5): the credential-source marking is set by
        // the operator side (the handoff) or an embedder — an agent marking
        // its own session would forge the trust indicator phase 6 builds on.
        // Refused by name, before the schema, so the caller gets this guidance
        // rather than a generic unexpected-property error.
        if ('credentialSource' in (body as object))
          throw new ServiceError(
            'INVALID_REQUEST',
            'credentialSource is server-assigned (the cookie handoff), never session input.'
          );
        // A scope belongs under `policy`, where it is validated.
        if ('scope' in (body as object))
          throw new ServiceError(
            'INVALID_REQUEST',
            'An engagement scope belongs under policy.scope, where it is validated.'
          );
        // ADR-015 B4: schema validation (compiled from the protocol's
        // SessionRequestSchema) replaces the hand-rolled checks; the
        // nested `policy` object maps onto the service's flat fields at
        // this boundary. The schema is strict: an unknown or misplaced key
        // (a policy field outside `policy`) is refused, never passed through.
        const validated = validateSessionRequest(body);
        if (!validated.ok) {
          const details = validated.issues
            .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
            .join('; ');
          return reply.status(400).send({
            error: {
              code: 'INVALID_REQUEST',
              message: `Invalid session request: ${details}`,
              retryable: false,
            },
          });
        }
        if (validated.value.cdpAttach === true) {
          const address = fastify.server.address();
          if (
            !isOperatorLoopback(request.ip) ||
            (address !== null &&
              (typeof address === 'string' || !isOperatorLoopback(address.address)))
          )
            try {
              requireCdpAttachAdmission('local_only');
            } catch (error) {
              const refusal = error as { message: string; details: Record<string, unknown> };
              throw new ServiceError('ENGINE_UNSUPPORTED', refusal.message, false, refusal.details);
            }
        }
        const { cookies, ...validatedRequest } = validated.value;
        const policy = (body as { policy?: SessionPolicy }).policy;
        const createRequest: ServiceSessionRequest = { ...validatedRequest };
        if (policy?.approval !== undefined) createRequest.approval = policy.approval;
        // Structurally identical wire shapes; the protocol type's stricter
        // optionals (no | undefined) need explicit casts under
        // exactOptionalPropertyTypes - hence assignments, not spreads.
        if (cookies !== undefined) {
          createRequest.cookies = cookies as NonNullable<ServiceSessionRequest['cookies']>;
        }
        if (policy?.allowedHosts !== undefined) {
          createRequest.allowedHosts = policy.allowedHosts;
        }
        if (policy?.blockedHosts !== undefined) {
          createRequest.blockedHosts = policy.blockedHosts;
        }
        if (policy?.allowDownloads !== undefined) {
          createRequest.allowDownloads = policy.allowDownloads;
        }
        if (policy?.maxDownloadBytes !== undefined) {
          createRequest.maxDownloadBytes = policy.maxDownloadBytes;
        }
        if (policy?.allowServiceWorkers !== undefined) {
          createRequest.allowServiceWorkers = policy.allowServiceWorkers;
        }
        if (policy?.scope !== undefined) {
          createRequest.scope = policy.scope;
        }
        const session = await service.createSession(createRequest as never);
        return reply.status(201).send(session);
      });

      onTransport(
        'GET',
        '/sessions/:sessionId/control',
        async (request, reply) => {
          const { sessionId } = params(request, 'sessionId');
          requireOwnership(sessionId, tenantOf(request));
          const control = service.authority.get(sessionId);
          if (!control) throw new ServiceError('NOT_FOUND', 'Session is not controlled');
          return reply.send(service.authority.status(sessionId));
        },
        { capability: 'session.control' }
      );
      for (const action of ['takeover', 'prepare-resume', 'delegate'] as const) {
        onTransport(
          'POST',
          `/sessions/:sessionId/control/${action}`,
          async (request, reply) => {
            const { sessionId } = params(request, 'sessionId');
            const principal = principals.get(request);
            if (principal?.actor !== 'operator') throw new ServiceError(...FLOOR_OPERATOR_REQUIRED);
            requireOwnership(sessionId, tenantOf(request));
            const control = service.authority.get(sessionId);
            if (!control) throw new ServiceError('NOT_FOUND', 'Session is not controlled');
            if (action === 'takeover') return reply.send(service.authority.takeover(sessionId));
            if (action === 'delegate') {
              const body = request.body as { epoch?: unknown; mode?: unknown } | undefined;
              const epoch = body?.epoch;
              if (!Number.isSafeInteger(epoch) || (epoch as number) < 0)
                throw new ServiceError('INVALID_REQUEST', 'A valid review epoch is required');
              if (body?.mode !== undefined && !isAgentMode(body.mode))
                throw new ServiceError('INVALID_REQUEST', 'A valid agent mode is required');
              return reply.send(service.authority.delegate(sessionId, epoch as number, body?.mode));
            }
            const review = control.prepareResume();
            service.invalidateControlObservations(sessionId);
            return httpPublication.respond(request, reply, async (output) => {
              await service.authority.run(
                sessionId,
                principal,
                {},
                async () => {
                  try {
                    const pages = await service.listPages(sessionId);
                    const observations = [];
                    for (const page of pages) {
                      const observed = await service.observe(sessionId, page.pageId, {});
                      observations.push({
                        pageId: page.pageId,
                        url: observed.url,
                        title: observed.title,
                        revision: observed.revision,
                        summary: observed.summary,
                      });
                    }
                    return { ...review, pages: observations };
                  } catch (error) {
                    // Collection failed, not delivery. Never take over a replacement owner.
                    if (service.authority.get(sessionId) === control)
                      service.authority.takeover(sessionId);
                    throw error;
                  }
                },
                undefined,
                output.publication()
              );
            });
          },
          { ...(action === 'prepare-resume' ? { publication: 'guarded' as const } : {}) }
        );
      }
      onTransport(
        'GET',
        '/sessions/:sessionId/operations/:operationId',
        async (request, reply) => {
          const { sessionId, operationId } = params(request, 'sessionId', 'operationId');
          requireOwnership(sessionId, tenantOf(request));
          const principal = principals.get(request);
          if (!principal) throw new ServiceError('FORBIDDEN', 'Session authority does not match');
          return httpPublication.respond(request, reply, async (output) => {
            const operation = await service.authority.publishOperation(
              sessionId,
              principal,
              operationId,
              output.publication()
            );
            if (!operation) throw new ServiceError('NOT_FOUND', 'Operation is not recorded');
          });
        },
        { capability: 'session.control', publication: 'guarded' }
      );

      /** Both approval routes share this prologue: an operator-or-human actor, ownership,
       * and (TD-BROWSER-16 phase 1) the human-only gate on non-act kinds — an API-key
       * operator, which an agent may hold, is refused for them. Returns the non-act kind
       * when the caller must take the separate path, undefined for the act path. */
      const requireApprovalAccess = async (
        request: RequestData,
        sessionId: string,
        tokenId: string
      ) => {
        if (
          request.principal?.actor !== 'operator' &&
          request.principal?.actor !== 'human-operator'
        )
          throw new ServiceError(...FLOOR_OPERATOR_REQUIRED);
        requireOwnership(sessionId, tenantOf(request));
        const nonAct = await service.getApprovalKind(sessionId, tokenId);
        if (nonAct !== undefined && request.principal?.actor !== 'human-operator')
          throw new ServiceError(...FLOOR_OPERATOR_REQUIRED);
        return nonAct;
      };

      on(
        'GET',
        '/sessions/:sessionId/approvals/:tokenId',
        async (request) => {
          const { sessionId, tokenId } = params(request, 'sessionId', 'tokenId');
          const nonAct = await requireApprovalAccess(request, sessionId, tokenId);
          if (nonAct !== undefined) {
            return responseDraft(await service.viewNonActApproval(sessionId, tokenId), 200);
          }
          const disclosure = await service.prepareApprovalDisclosureInScope(sessionId, tokenId);
          return responseDraft(disclosure.view, 200, { assertCurrent: disclosure.assertCurrent });
        },
        { operatorRoute: true }
      );
      on(
        'POST',
        '/sessions/:sessionId/approvals/:tokenId',
        async (request) => {
          const { sessionId, tokenId } = params(request, 'sessionId', 'tokenId');
          const nonAct = await requireApprovalAccess(request, sessionId, tokenId);
          if (nonAct !== undefined) {
            const nonActChecked = validateOperatorApprovalDecision(request.body);
            if (!nonActChecked.ok)
              throw new ServiceError(
                'INVALID_REQUEST',
                'Approval decision must be approve or deny'
              );
            return responseDraft(
              await service.decideNonActApproval(
                sessionId,
                tokenId,
                nonActChecked.value.decision,
                nonActChecked.value.lease
              ),
              200
            );
          }
          const checked = validateOperatorApprovalDecision(request.body);
          if (!checked.ok)
            throw new ServiceError('INVALID_REQUEST', 'Approval decision must be approve or deny');
          const disclosure = await service.prepareApprovalDisclosureInScope(
            sessionId,
            tokenId,
            checked.value.decision
          );
          return responseDraft(disclosure.view, 200, { assertCurrent: disclosure.assertCurrent });
        },
        { operatorRoute: true }
      );

      // TD-BROWSER-16 phase 5 (ADR-025 §5): the operator-granted action
      // lease. Human operator only — an agent (or an API-key operator, which
      // an agent may hold) can never request, extend or widen one; no
      // agent-facing schema accepts lease fields.
      on(
        'POST',
        '/sessions/:sessionId/lease',
        async (request) => {
          const { sessionId } = params(request, 'sessionId');
          // The human operator only (inline form: the `on` wrapper passes a
          // reduced request, like the approval routes above).
          if (request.principal?.actor !== 'human-operator')
            throw new ServiceError(...FLOOR_OPERATOR_REQUIRED);
          requireOwnership(sessionId, tenantOf(request));
          const body = (request.body ?? {}) as {
            hosts?: unknown;
            expiresInMs?: unknown;
            maxActions?: unknown;
          };
          if (
            !Array.isArray(body.hosts) ||
            body.hosts.length === 0 ||
            body.hosts.length > 16 ||
            !body.hosts.every((host) => typeof host === 'string') ||
            typeof body.expiresInMs !== 'number' ||
            typeof body.maxActions !== 'number'
          )
            throw new ServiceError(
              'INVALID_REQUEST',
              'A lease grant is { hosts: string[], expiresInMs, maxActions }'
            );
          return responseDraft(
            await service.grantActionLease(sessionId, {
              hosts: body.hosts as string[],
              expiresInMs: body.expiresInMs,
              maxActions: body.maxActions,
            }),
            201
          );
        },
        { operatorRoute: true }
      );

      // Application surface (shared-infra slice 2). Binding is operator-only
      // while the human owns the session; discovery/execution/receipts are
      // open to operators (ownership-checked) and to delegated grants whose
      // mode carries the application capabilities. onTransport preserves their
      // own admissions; the ordinary browser envelope must not nest a ticket.
      onTransport(
        'PUT',
        '/sessions/:sessionId/application',
        async (request, reply) => {
          const { sessionId } = params(request, 'sessionId');
          const principal = principals.get(request);
          if (principal?.actor !== 'operator') throw new ServiceError(...FLOOR_OPERATOR_REQUIRED);
          requireOwnership(sessionId, tenantOf(request));
          requireBody(request.body);
          return reply.send(service.applicationBind(sessionId, principal, request.body));
        },
        {}
      );
      onTransport(
        'DELETE',
        '/sessions/:sessionId/application',
        async (request, reply) => {
          const { sessionId } = params(request, 'sessionId');
          const principal = principals.get(request);
          if (principal?.actor !== 'operator') throw new ServiceError(...FLOOR_OPERATOR_REQUIRED);
          requireOwnership(sessionId, tenantOf(request));
          return reply.send(service.applicationUnbind(sessionId, principal));
        },
        {}
      );
      onTransport(
        'GET',
        '/sessions/:sessionId/application',
        async (request, reply) => {
          const { sessionId } = params(request, 'sessionId');
          requireOwnership(sessionId, tenantOf(request));
          const principal = principals.get(request) ?? { actor: 'operator' as const, tenant: '' };
          return httpPublication.respond(request, reply, async (output) => {
            await service.applicationDiscover(sessionId, principal, output.publication());
          });
        },
        { capability: 'application.discover', publication: 'guarded' }
      );
      onTransport(
        'POST',
        '/sessions/:sessionId/application/reviews',
        async (request, reply) => {
          const { sessionId } = params(request, 'sessionId');
          const principal = principals.get(request);
          if (principal?.actor !== 'operator') throw new ServiceError(...FLOOR_OPERATOR_REQUIRED);
          requireOwnership(sessionId, tenantOf(request));
          if (request.headers['x-agentbrowser-operation-id'] !== undefined)
            throw new ServiceError(
              'INVALID_REQUEST',
              'Review creation does not accept an execution operation header'
            );
          requireBody(request.body);
          return httpPublication.respond(request, reply, async (output) => {
            await service.applicationReview(
              sessionId,
              principal,
              request.body,
              output.publication()
            );
          });
        },
        { publication: 'guarded' }
      );
      onTransport(
        'POST',
        '/sessions/:sessionId/application/execute',
        async (request, reply) => {
          const { sessionId } = params(request, 'sessionId');
          requireOwnership(sessionId, tenantOf(request));
          requireBody(request.body);
          const principal = principals.get(request) ?? { actor: 'operator' as const, tenant: '' };
          return httpPublication.respond(request, reply, async (output) => {
            await service.applicationExecute(
              sessionId,
              principal,
              request.body,
              output.publication(),
              output.publication((operation) => ({ replay: true, operation }))
            );
          });
        },
        { capability: 'application.execute', publication: 'guarded' }
      );
      onTransport(
        'GET',
        '/sessions/:sessionId/application/receipts/:operationId',
        async (request, reply) => {
          const { sessionId, operationId } = params(request, 'sessionId', 'operationId');
          requireOwnership(sessionId, tenantOf(request));
          const principal = principals.get(request) ?? { actor: 'operator' as const, tenant: '' };
          return httpPublication.respond(request, reply, async (output) => {
            await service.applicationReceipt(
              sessionId,
              principal,
              operationId,
              output.publication((value) => value ?? null)
            );
          });
        },
        { capability: 'application.discover', publication: 'guarded' }
      );

      // Session event stream: WebSocket upgrade, JSON per frame.
      v1.get(
        '/sessions/:sessionId/events',
        { websocket: true, config: { publication: 'stream' } },
        (socket, request) => {
          const { sessionId } = params(request, 'sessionId');
          const tenant = (request as FastifyRequest & { tenant?: string }).tenant;
          if (tenant !== undefined) {
            const session = service.getSession(sessionId);
            const owner = session && (session as { tenantId?: string }).tenantId;
            if (owner !== undefined && owner !== tenant) {
              socket.close(4403, 'forbidden');
              return;
            }
          }

          const unsubscribe = service.subscribe(sessionId, (event) => {
            socket.send(JSON.stringify(event));
          });
          if (unsubscribe === undefined) {
            socket.close(4404, 'session not found');
            return;
          }

          socket.on('close', () => {
            unsubscribe();
          });
          socket.on('error', () => {
            unsubscribe();
          });
        }
      );

      onTransport('GET', '/sessions', async (request, reply) => {
        return reply.send({ sessions: service.listSessions(tenantOf(request)) });
      });

      on(
        'GET',
        '/sessions/:sessionId',
        async (request) => {
          const { sessionId } = params(request, 'sessionId');
          requireOwnership(sessionId, tenantOf(request));
          const session = service.getSession(sessionId);

          if (!session) {
            throw new ServiceError('SESSION_NOT_FOUND', `Session ${sessionId} not found`);
          }

          return responseDraft(session);
        },
        { capability: 'session.control' }
      );

      // T10 M2: the engagement scope in effect, and a dry-run check that
      // spends no budget and records no denial.
      on(
        'GET',
        '/sessions/:sessionId/scope',
        async (request) => {
          const { sessionId } = params(request, 'sessionId');
          requireOwnership(sessionId, tenantOf(request));
          return responseDraft(service.getScopeStatus(sessionId));
        },
        { capability: 'session.control' }
      );

      on(
        'GET',
        '/sessions/:sessionId/scope/check',
        async (request) => {
          const { sessionId } = params(request, 'sessionId');
          requireOwnership(sessionId, tenantOf(request));
          const query = (request.query ?? {}) as { url?: unknown; method?: unknown };
          if (typeof query.url !== 'string' || query.url.length === 0)
            throw new ServiceError('INVALID_REQUEST', 'url is required');
          if (
            query.method !== undefined &&
            (typeof query.method !== 'string' || !/^[A-Za-z]{1,16}$/.test(query.method))
          )
            throw new ServiceError('INVALID_REQUEST', 'method must be an HTTP method name');
          return responseDraft(
            service.checkScope(sessionId, {
              url: query.url,
              ...(typeof query.method === 'string' ? { method: query.method } : {}),
            })
          );
        },
        { capability: 'session.control' }
      );

      // TD-BROWSER-16 phase 6 (ADR-025 section 3): the cookie handoff. Agent-
      // invoked (the agent relays APPROVAL_REQUIRED to the operator and
      // retries with the token); the DECISION it consumes is human-operator
      // only, on the approvals route above. Runs under one per-session lock;
      // the mark precedes the write, so racing exports are refused.
      on(
        'POST',
        '/sessions/:sessionId/cookies/handoff',
        async (request) => {
          const { sessionId } = params(request, 'sessionId');
          requireOwnership(sessionId, tenantOf(request));
          const body = request.body;
          requireBody(body);
          const validated = validateCookieHandoffRequest(body);
          if (!validated.ok) {
            const details = validated.issues
              .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
              .join('; ');
            throw new ServiceError('INVALID_REQUEST', `Invalid handoff request: ${details}`);
          }
          const result = await service.handoffCookies(sessionId, validated.value);
          return responseDraft(result, 200);
        },
        { safe: true }
      );

      on('GET', '/sessions/:sessionId/cookies', async (request) => {
        const { sessionId } = params(request, 'sessionId');
        requireOwnership(sessionId, tenantOf(request));
        return responseDraft({ cookies: await service.getSessionCookies(sessionId) });
      });

      // A3 evidence: the session's recent event ledger (console replay).
      on('GET', '/sessions/:sessionId/events/replay', async (request) => {
        const { sessionId } = params(request, 'sessionId');
        requireOwnership(sessionId, tenantOf(request));
        // request.* events live in their own ledger (network summary,
        // spec 5.1); getSessionEvents routes the filter accordingly.
        // Paging (N1 G2) applies to one stream at a time: since/limit
        // require a type filter, since cursors are per-stream sequences.
        const query = (request.query ?? {}) as { type?: string; since?: string; limit?: string };
        const options: { type?: string; since?: number; limit?: number } = {};
        if (query.type !== undefined && query.type !== '') options.type = query.type;
        if (query.since !== undefined) {
          if (options.type === undefined)
            return responseDraft({ error: 'since requires a type filter' }, 400);
          const since = Number(query.since);
          // -1 (from the start) is the cursor an empty page hands back.
          if (!Number.isSafeInteger(since) || since < EVENT_REPLAY_MIN_SINCE)
            return responseDraft({ error: 'since must be an integer >= -1' }, 400);
          options.since = since;
        }
        if (query.limit !== undefined) {
          if (options.type === undefined)
            return responseDraft({ error: 'limit requires a type filter' }, 400);
          const limit = Number(query.limit);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            return responseDraft({ error: 'limit must be an integer in [1, 1000]' }, 400);
          options.limit = limit;
        }
        return responseDraft(service.getSessionEvents(sessionId, options));
      });

      // A3 evidence: export the session's completed spans as an artifact.
      on('POST', '/sessions/:sessionId/trace', async (request) => {
        const { sessionId } = params(request, 'sessionId');
        requireOwnership(sessionId, tenantOf(request));
        return responseStatus(201, await service.exportTrace(sessionId));
      });

      // A3 evidence: capture the page's current HTML as an artifact.
      on(
        'POST',
        '/sessions/:sessionId/pages/:pageId/html',
        async (request) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          requireOwnership(sessionId, tenantOf(request));
          return responseStatus(201, await service.exportHtml(sessionId, pageId));
        },
        { capability: 'page.capture', safe: true }
      );

      on(
        'GET',
        '/sessions/:sessionId/pages/:pageId/snapshot',
        async (request) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          requireOwnership(sessionId, tenantOf(request));
          // Payload economics (TD-BROWSER-8 pressure matrix, row 4).
          const query = request.query as {
            maxElements?: string;
            maxBytes?: string;
            controls?: string;
          };
          const maxElements =
            query.maxElements !== undefined ? Number.parseInt(query.maxElements, 10) : undefined;
          const maxBytes =
            query.maxBytes !== undefined ? Number.parseInt(query.maxBytes, 10) : undefined;
          // Strict enum per the published OpenAPI contract: anything but
          // true/false is a usage error, never a silent no-op that reads as
          // "the page has no custom controls" (round-5/F7).
          if (
            query.controls !== undefined &&
            query.controls !== 'true' &&
            query.controls !== 'false'
          ) {
            throw new ServiceError('INVALID_REQUEST', "controls must be 'true' or 'false'");
          }
          const controls = query.controls === 'true';
          return responseDraft(
            await service.getSnapshot(sessionId, pageId, {
              ...(maxElements !== undefined ? { maxElements } : {}),
              ...(maxBytes !== undefined ? { maxBytes } : {}),
              ...(controls ? { controls } : {}),
            })
          );
        },
        { capability: 'page.observe' }
      );

      on(
        'POST',
        '/sessions/:sessionId/pages/:pageId/plan',
        async (request) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          requireOwnership(sessionId, tenantOf(request));
          // Empty-body tolerance resolves a zero-length JSON body to
          // undefined; every route must dereference defensively.
          const body = (request.body ?? {}) as { actions?: Array<Record<string, unknown>> };
          let actions: Array<Record<string, unknown>>;
          try {
            actions = parsePlanSteps(body.actions);
          } catch (error) {
            return responseStatus(400, {
              error: {
                code: 'INVALID_REQUEST',
                message: error instanceof Error ? error.message : 'Invalid plan steps',
                retryable: false,
              },
            });
          }
          return executionResponse(
            await service.executePlan(sessionId, pageId, actions as unknown as ServiceActRequest[])
          );
        },
        { capability: 'page.interact', browserDurable: 'plan' }
      );

      on(
        'POST',
        '/sessions/:sessionId/pages/:pageId/outcomes',
        async (request) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          requireOwnership(sessionId, tenantOf(request));
          requireBody(request.body);
          return outcomeResponse(await service.executeOutcome(sessionId, pageId, request.body));
        },
        { capability: 'page.interact' }
      );

      onTransport(
        'DELETE',
        '/sessions/:sessionId',
        async (request, reply) => {
          const { sessionId } = params(request, 'sessionId');
          requireOwnership(sessionId, tenantOf(request));
          await service.closeSession(sessionId);
          return reply.send({ sessionId, status: 'closed' });
        },
        {}
      );

      // Page management endpoints
      on(
        'GET',
        '/sessions/:sessionId/pages',
        async (request) => {
          const { sessionId } = params(request, 'sessionId');
          requireOwnership(sessionId, tenantOf(request));
          return responseDraft({ pages: await service.listPages(sessionId) });
        },
        { capability: 'page.observe' }
      );

      on(
        'POST',
        '/sessions/:sessionId/pages',
        async (request) => {
          const { sessionId } = params(request, 'sessionId');
          requireOwnership(sessionId, tenantOf(request));
          const { url } = (request.body ?? {}) as { url?: unknown };
          if (url !== undefined && typeof url !== 'string') {
            return responseStatus(400, {
              error: {
                code: 'INVALID_REQUEST',
                message: 'url must be a string',
                retryable: false,
              },
            });
          }
          const page = await service.createPage(sessionId, url !== undefined ? { url } : undefined);
          return responseStatus(201, page);
        },
        { capability: 'session.manage' }
      );

      on(
        'GET',
        '/sessions/:sessionId/pages/:pageId',
        async (request) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          requireOwnership(sessionId, tenantOf(request));
          const page = await service.getPage(sessionId, pageId);

          if (!page) {
            return responseStatus(404, {
              error: {
                code: 'NOT_FOUND',
                message: `Page ${pageId} not found`,
                retryable: false,
              },
            });
          }

          return responseDraft(page);
        },
        { capability: 'page.observe' }
      );

      on(
        'DELETE',
        '/sessions/:sessionId/pages/:pageId',
        async (request) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          requireOwnership(sessionId, tenantOf(request));
          await service.closePage(sessionId, pageId);
          return responseDraft({ pageId, status: 'closed' });
        },
        { capability: 'session.manage' }
      );

      // Navigation endpoint
      on(
        'POST',
        '/sessions/:sessionId/pages/:pageId/navigate',
        async (request) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          requireOwnership(sessionId, tenantOf(request));
          const body = request.body;
          requireBody(body);

          const { url, waitUntil } = body as { url?: string; waitUntil?: string };

          if (typeof url !== 'string' || url.length === 0) {
            return responseStatus(400, {
              error: {
                code: 'INVALID_REQUEST',
                message: 'url is required and must be a string',
                retryable: false,
              },
            });
          }

          const result = await service.navigate(sessionId, pageId, {
            url,
            ...(waitUntil !== undefined
              ? { waitUntil: waitUntil as 'load' | 'domcontentloaded' | 'networkidle' }
              : {}),
          });
          return responseDraft(result);
        },
        { capability: 'page.navigate' }
      );

      // Observation endpoint
      on(
        'POST',
        '/sessions/:sessionId/pages/:pageId/observe',
        async (request) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          requireOwnership(sessionId, tenantOf(request));
          const observation = await service.observe(
            sessionId,
            pageId,
            (request.body === undefined ? {} : request.body) as never
          );
          return responseDraft(observation);
        },
        { capability: 'page.observe', safe: true }
      );

      on(
        'POST',
        '/sessions/:sessionId/pages/:pageId/autofill',
        async (request) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          requireOwnership(sessionId, tenantOf(request));
          const report = await service.autofill(sessionId, pageId, request.body);
          return executionResponse(report);
        },
        { capability: 'page.form', browserDurable: 'autofill' }
      );

      // Action execution endpoint
      on(
        'POST',
        '/sessions/:sessionId/pages/:pageId/act',
        async (request) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          requireOwnership(sessionId, tenantOf(request));
          const body = request.body;
          requireBody(body);

          const validated =
            typeof body === 'object' &&
            body !== null &&
            'steps' in (body as Record<string, unknown>)
              ? validateWireActionBatch(body)
              : validateWireAction(body);
          if (!validated.ok) {
            throw new ServiceError('INVALID_REQUEST', 'Invalid action request', false, {
              issues: validated.issues,
              validActions: [...DELIVERED_ACTION_TYPES].sort(),
            });
          }
          const result = await service.act(sessionId, pageId, validated.value as ServiceActRequest);
          if (validated.warnings?.length) {
            return executionResponse(
              copyBrowserReport(result, { ...result, warnings: validated.warnings })
            );
          }
          return executionResponse(result);
        },
        { capability: 'page.interact', browserDurable: 'act' }
      );

      // Download endpoint: policy-gated artifact capture
      on('POST', '/sessions/:sessionId/pages/:pageId/download', async (request) => {
        const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
        requireOwnership(sessionId, tenantOf(request));
        const body = request.body;
        requireBody(body);

        const { url, filename } = body as { url?: string; filename?: string };
        if (typeof url !== 'string' || url.length === 0) {
          return responseStatus(400, {
            error: {
              code: 'INVALID_REQUEST',
              message: 'url is required and must be a string',
              retryable: false,
            },
          });
        }

        const artifact = await service.download(sessionId, pageId, {
          url,
          ...(filename !== undefined ? { filename } : {}),
        });
        return responseDraft(artifact);
      });

      // Artifact retrieval, scoped to the owning session
      on(
        'GET',
        '/sessions/:sessionId/artifacts/:artifactId',
        async (request) => {
          const { sessionId, artifactId } = params(request, 'sessionId', 'artifactId');
          // Access granted by session ownership OR a short-lived signed
          // token minted when the artifact was created (spec 13.1).
          const query = request.query as { token?: string };
          const tokenValid =
            query.token !== undefined && artifactAuth.verify(artifactId, query.token);
          const stored = service.getArtifact(
            sessionId,
            artifactId,
            tokenValid ? undefined : tenantOf(request)
          );
          if (!stored) {
            return responseStatus(404, {
              error: {
                code: 'NOT_FOUND',
                message: `Artifact ${artifactId} not found`,
                retryable: false,
              },
            });
          }

          return responseDraft({
            metadata: stored.metadata,
            contentBase64: Buffer.from(stored.bytes).toString('base64'),
          });
        },
        { capability: 'page.capture', terminal: 'retained-resource' }
      );

      // Collect an intercepted in-page download (spec 10)
      on('POST', '/sessions/:sessionId/pages/:pageId/downloads/:filename', async (request) => {
        const { sessionId, pageId, filename } = params(request, 'sessionId', 'pageId', 'filename');
        requireOwnership(sessionId, tenantOf(request));

        const artifact = await service.collectDownload(sessionId, pageId, filename);
        return responseDraft(artifact);
      });

      // PDF capture endpoint
      on(
        'POST',
        '/sessions/:sessionId/pages/:pageId/pdf',
        async (request) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          requireOwnership(sessionId, tenantOf(request));
          const body = (request.body ?? {}) as {
            landscape?: boolean;
            displayHeaderFooter?: boolean;
            printBackground?: boolean;
          };

          const artifact = await service.pdf(sessionId, pageId, {
            ...(body.landscape !== undefined ? { landscape: body.landscape } : {}),
            ...(body.displayHeaderFooter !== undefined
              ? { displayHeaderFooter: body.displayHeaderFooter }
              : {}),
            ...(body.printBackground !== undefined
              ? { printBackground: body.printBackground }
              : {}),
          });
          return responseDraft(artifact);
        },
        { capability: 'page.capture', safe: true }
      );

      // Extraction endpoint (spec 12): deterministic extractors with evidence
      on(
        'POST',
        '/sessions/:sessionId/pages/:pageId/extract',
        async (request) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          requireOwnership(sessionId, tenantOf(request));
          const body = request.body;
          requireBody(body);

          const format = (body as { format?: string }).format;
          const schema = (body as { schema?: Record<string, unknown> }).schema;
          const records = (
            body as {
              records?: { container: string; fields: Record<string, string>; limit?: number };
            }
          ).records;
          const supported: readonly string[] = DELIVERED_EXTRACT_FORMATS;
          if (typeof format !== 'string' || !supported.includes(format)) {
            return responseStatus(400, {
              error: {
                code: 'INVALID_REQUEST',
                message: `Unknown format ${String(format)}. Supported: ${supported.join(', ')}`,
                retryable: false,
              },
            });
          }

          const result = await service.extract(sessionId, pageId, {
            format: format as never,
            ...((body as { maxBytes?: number }).maxBytes !== undefined
              ? { maxBytes: (body as { maxBytes: number }).maxBytes }
              : {}),
            ...(schema !== undefined ? { schema } : {}),
            ...(records !== undefined ? { records } : {}),
          });
          return responseDraft(result);
        },
        { capability: 'page.extract', safe: true }
      );

      // Screenshot endpoint
      on(
        'POST',
        '/sessions/:sessionId/pages/:pageId/screenshot',
        async (request) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          requireOwnership(sessionId, tenantOf(request));
          const artifact = await service.screenshot(
            sessionId,
            pageId,
            (request.body === undefined ? {} : request.body) as never
          );
          return responseDraft(artifact);
        },
        { capability: 'page.capture', safe: true }
      );
    },
    { prefix: '/v1' }
  );

  // Read-only handle for operator-surface tests; not part of the public API.
  fastify.decorate('service', service);
  fastify.addHook('onClose', async () => {
    await loginBrowser.closeForShutdown();
  });
  return fastify;
}

export async function startServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const server = await buildServer(options);
  // PORT/HOST let a supervisor (the SDK's managed launcher, containers)
  // place the server without code changes.
  const port = options.port ?? envPort() ?? 5709;
  // Loopback by default: the service is a local agent's browser and reads
  // local files on its behalf (screenshots, upload paths) - exposing that
  // to every interface by default would make the LAN a trust boundary the
  // operator never chose. Network exposure is an explicit HOST/options.host
  // (the Dockerfile sets HOST=0.0.0.0 for container port publishing).
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';

  await server.listen({ port, host });
  console.log(`Server listening on ${host}:${port}`);

  return server;
}

/** Parse PORT into a valid integer, ignoring junk rather than crashing. */
function envPort(): number | undefined {
  const raw = process.env.PORT;
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : undefined;
}
