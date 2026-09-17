import { INTERACTION_GUIDANCE, parseAutofillReport, parsePlanReport } from '@agentbrowser/protocol';
import type { PlanReport } from '@agentbrowser/protocol';
/**
 * AgentBrowser TypeScript SDK Client
 *
 * Provides a fluent TypeScript client API for interacting with
 * the AgentBrowser REST API.
 */

import type {
  AgentMode,
  AutofillReport,
  AutofillRequest,
  ControlView,
  DELIVERED_ACTION_TYPES,
  OperationRecord,
  RunCursor,
  SessionRequest,
} from '@agentbrowser/protocol';

export type { ControlView, OperationRecord, RunCursor } from '@agentbrowser/protocol';
export type { AutofillRequest, AutofillReport } from '@agentbrowser/protocol';
export interface MutationOptions {
  operationId?: string;
}

export interface ClientOptions {
  baseUrl?: string;
  timeout?: number;
  headers?: Record<string, string>;
  /** Bearer API key; sent as Authorization on every request. */
  apiKey?: string;
}

// ADR-015 (B2/B7): the SDK mirrors the protocol's request types instead of
// redeclaring them - the drift this replaces had already made tenantId
// required here but optional in the protocol, engine a loose string here
// but EngineType there, and per-session policy inexpressible from SDK
// clients entirely. Type-level only: tenantId stays REQUIRED at runtime on
// every real surface (the MCP tool schema, the server's validator, and the
// no-keys-mode fallback), so relaxing it here is a widening that breaks
// no caller.
export type { SessionCookie, SessionRequest } from '@agentbrowser/protocol';

export interface SessionResponse {
  sessionId: string;
  status: string;
  engine?: {
    name: string;
    version: string;
    capabilities: Record<string, unknown>;
  };
  createdAt: string;
  ttlMs?: number;
  idleTimeoutMs?: number;
  /** Number of live pages registered to the session right now. */
  pages?: number;
}

export interface PageResponse {
  pageId: string;
  sessionId: string;
  status: string;
  url?: string;
  title?: string;
}

export interface NavigationRequest {
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

export interface NavigationResponse {
  status: string;
  url: string;
  redirectChain: string[];
}

export interface ObservationRequest {
  mode?: 'interactive' | 'content' | 'accessibility';
  maxElements?: number;
  maxBytes?: number;
  /** Return only what changed since this revision. */
  sinceRevision?: number;
  /** Resume a truncated observation from the cursor's nextOrdinal. */
  continueFrom?: number;
  /** Optional enrichments, e.g. ["overlays"] or ["fileInputs"]. */
  include?: string[];
}

export interface ObservationResponse {
  sessionId: string;
  pageId: string;
  revision: number;
  url: string;
  title: string;
  status: string;
  summary: string;
  elements: Array<{
    ref: string;
    role: string;
    name?: string;
    visible: boolean;
    enabled: boolean;
    value?: string;
    /** Link destination, present on role:"link" elements. */
    href?: string;
    /** True when the captured href exceeded the 2048-char capture limit. */
    hrefTruncated?: boolean;
    /**
     * Engine-captured attributes; populated for role:"fileinput" elements
     * requested via include:["fileInputs"] (carries id, accept, and multiple
     * so callers can tell ambiguous file inputs apart).
     */
    attributes?: Record<string, string>;
    /**
     * Checked state for checkbox/radio/switch roles: true/false from the
     * engine's authoritative read; absent when unknowable (tri-state mixed,
     * or degraded observations without bound handles).
     */
    checked?: boolean | undefined;
  }>;
  truncated: boolean;
  untrustedContent: boolean;
  /** Present only when requested via include:["overlays"]. */
  overlays?: Array<{
    tag: string;
    role?: string;
    name?: string;
    covers: number;
  }>;
  /** Present only when the observation is truncated. */
  continuation?: { nextOrdinal: number; remaining: number };
  /**
   * True when the whole-page ariaSnapshot budget was exceeded and `elements`
   * came from a DOM-tag-only fallback: roles are bare HTML tags with no
   * name/value, and any custom widget with no native form control (e.g. a
   * div-based combobox) is entirely absent. Do not trust role/name matching
   * on this observation - retry with a larger snapshotTimeoutMs on the
   * session, or narrow the observation instead.
   */
  degraded?: boolean;
  /** Why `degraded` is set, when it is. Currently only one cause exists. */
  degradedReason?: 'aria-snapshot-timeout' | 'dom-semantic-subset';
}

/** The delivered action set, derived from the protocol source of truth. */
export type DeliveredAction = (typeof DELIVERED_ACTION_TYPES)[number];

export type ActionRequest = import('@agentbrowser/protocol').WireActionRequest;
export { validateWireAction } from '@agentbrowser/protocol';

export interface ActionResult {
  status: string;
  actionId?: string;
  newRevision?: number;
  observation?: ObservationResponse;
}

export interface ExtractRequest {
  format: 'text' | 'markdown' | 'links' | 'tables' | 'forms' | 'jsonld' | 'schema' | 'records';
  /** JSON Schema constraining the extraction (format: 'schema' only). */
  schema?: Record<string, unknown>;
  /** Repeating-structure selectors (format: 'records' only). */
  records?: { container: string; fields: Record<string, string>; limit?: number };
}

// ADR-015 single-source-of-truth re-exports: surfaces (CLI, MCP) import
// these from the SDK rather than redeclaring them.
export {
  DELIVERED_EXTRACT_FORMATS,
  REF_PATTERN,
  parseRef,
  parseAutofillRequest,
} from '@agentbrowser/protocol';
export type { DeliveredExtractFormat } from '@agentbrowser/protocol';
export { UsageError, formatErrorForUser } from '@agentbrowser/protocol';

export interface ExtractResult {
  data: unknown;
  evidence: Array<{
    url: string;
    revision: number;
    ref?: string;
    index?: number;
    text?: string;
    hash: string;
  }>;
  warnings?: string[];
  /** Which model adapter contributed (only when one is injected). */
  modelUsed?: string;
  tokenUsage?: Record<string, unknown>;
}

export interface ScreenshotRequest {
  fullPage?: boolean;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  maskSensitive?: boolean;
}

export interface ArtifactRef {
  artifactId: string;
  type: string;
  contentType: string;
  sizeBytes: number;
  url: string;
}

export interface PdfRequest {
  landscape?: boolean;
  displayHeaderFooter?: boolean;
  printBackground?: boolean;
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  action?: string;
  traceId?: string;
}

export class AgentBrowserError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public details?: Record<string, unknown>,
    public action?: string,
    public traceId?: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'AgentBrowserError';
  }
}

/**
 * TD-BROWSER-6: a cookie as exported by the service's scoped cookie export.
 * Structurally the wire shape of NormalizedCookie (engine package), kept
 * local so the SDK does not depend on the engine package.
 */
export interface ExportedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * TD-BROWSER-8 self-contained snapshot payload: everything a caller needs to
 * build one browser_plan call without further round-trips. `mode` is the
 * page's adaptive mode - `verified` means recent ref churn was detected and
 * plan self-heal will require a stricter role+label match. Shared by the SDK,
 * MCP server and REST surface; declare it once, here.
 */
export interface PageSnapshot {
  url: string;
  title: string;
  revision: number;
  mode: 'stable' | 'verified';
  fields: Array<{ ref: string; role: string; label: string }>;
  truncated?: boolean;
  /**
   * True when the whole-page ariaSnapshot budget was exceeded and `fields`
   * came from a DOM-tag-only fallback: roles are bare HTML tags and any
   * custom widget with no native form control (e.g. a div-based combobox)
   * is entirely absent, even though `fields` looks structurally identical
   * either way. Retry with a larger snapshotTimeoutMs on the session.
   */
  degraded?: boolean;
  /** Why `degraded` is set, when it is. Currently only one cause exists. */
  degradedReason?: 'aria-snapshot-timeout' | 'dom-semantic-subset';
}

/**
 * F6: the SDK's one HTTP mechanic - timeout, JSON encode/decode, error-decode
 * - lives here, not per-method in SessionsClient. A second HTTP-consuming
 * client (there is only one today) would take an HttpClient instance and
 * reuse requestJson() instead of re-implementing this.
 */
class HttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly headers: Record<string, string>
  ) {}

  async requestJson<T>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      operationId?: string;
      timeoutMs?: number;
      parseResponse?: (input: unknown) => T;
    } = {}
  ): Promise<T> {
    const operationId =
      path.startsWith('/v1/sessions/') &&
      !path.includes('/control') &&
      init.method &&
      init.method !== 'GET'
        ? (init.operationId ?? this.headers['x-agentbrowser-operation-id'] ?? crypto.randomUUID())
        : undefined;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), init.timeoutMs ?? this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...this.headers,
          ...(operationId ? { 'x-agentbrowser-operation-id': operationId } : {}),
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        let error: ApiError;
        try {
          const data = (await response.json()) as { error?: ApiError };
          error = data.error || {
            code: 'UNKNOWN_ERROR',
            message: 'Unknown error',
            retryable: false,
          };
        } catch (cause) {
          if (controller.signal.aborted) throw cause;
          error = {
            code: 'UNKNOWN_ERROR',
            message: `HTTP ${response.status}: ${response.statusText}`,
            retryable: false,
          };
        }
        throw new AgentBrowserError(
          error.code,
          error.message,
          error.retryable,
          { ...error.details, ...(operationId ? { operationId } : {}) },
          error.action,
          error.traceId
        );
      }

      const result = (await response.json()) as T & { replay?: boolean; operation?: unknown };
      if (result?.replay === true)
        throw new AgentBrowserError(
          'OPERATION_RECORDED',
          'Operation already recorded; reconcile its status before taking further action',
          false,
          { operationId, operation: result.operation }
        );
      if (init.parseResponse) {
        try {
          return init.parseResponse(result);
        } catch {
          throw new AgentBrowserError(
            'INVALID_RESPONSE',
            `Invalid operation response. ${INTERACTION_GUIDANCE.uncertainWrite}`,
            false,
            operationId ? { operationId } : undefined
          );
        }
      }
      return result as T;
    } catch (error) {
      if (controller.signal.aborted) {
        // A timed-out mutation may have run: never advertise blind retry safety.
        throw new AgentBrowserError(
          'TIMEOUT',
          'Request timeout; outcome may be unknown',
          false,
          operationId ? { operationId } : undefined
        );
      }
      if (!(error instanceof AgentBrowserError) && operationId)
        throw new AgentBrowserError(
          'TRANSPORT_ERROR',
          'Response unavailable; reconcile the operation before retrying',
          false,
          { operationId }
        );
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Sessions API client
 */
export class SessionsClient {
  constructor(private readonly http: HttpClient) {}

  async control(sessionId: string): Promise<ControlView> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/control`);
  }
  async takeover(sessionId: string): Promise<ControlView> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/control/takeover`, { method: 'POST' });
  }
  async prepareResume(sessionId: string): Promise<
    ControlView & {
      pages: Array<{
        pageId: string;
        url: string;
        title: string;
        revision: number;
        summary: string;
      }>;
    }
  > {
    return this.http.requestJson(`/v1/sessions/${sessionId}/control/prepare-resume`, {
      method: 'POST',
    });
  }
  async delegate(
    sessionId: string,
    epoch: number,
    mode?: AgentMode
  ): Promise<ControlView & { token: string; mode: AgentMode; cursor: RunCursor }> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/control/delegate`, {
      method: 'POST',
      body: { epoch, ...(mode ? { mode } : {}) },
    });
  }
  async operation(sessionId: string, operationId: string): Promise<OperationRecord> {
    return this.http.requestJson(
      `/v1/sessions/${sessionId}/operations/${encodeURIComponent(operationId)}`
    );
  }
  async listPages(sessionId: string): Promise<PageResponse[]> {
    const result = await this.http.requestJson<{ pages: PageResponse[] }>(
      `/v1/sessions/${sessionId}/pages`
    );
    return result.pages;
  }

  async create(request: SessionRequest): Promise<SessionResponse> {
    return this.http.requestJson('/v1/sessions', { method: 'POST', body: request });
  }

  async get(sessionId: string): Promise<SessionResponse> {
    return this.http.requestJson(`/v1/sessions/${sessionId}`);
  }

  async list(): Promise<SessionResponse[]> {
    const data = await this.http.requestJson<{ sessions: SessionResponse[] }>('/v1/sessions');
    return data.sessions;
  }

  async close(sessionId: string): Promise<void> {
    await this.http.requestJson(`/v1/sessions/${sessionId}`, { method: 'DELETE' });
  }

  async createPage(
    sessionId: string,
    request?: { url?: string },
    options: MutationOptions = {}
  ): Promise<PageResponse> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages`, {
      method: 'POST',
      ...options,
      ...(request !== undefined ? { body: request } : {}),
    });
  }

  async getPage(sessionId: string, pageId: string): Promise<PageResponse> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}`);
  }

  async closePage(sessionId: string, pageId: string): Promise<void> {
    await this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}`, {
      method: 'DELETE',
    });
  }

  /** TD-BROWSER-6: scoped cookie export — the read half of the credential handoff loop. */
  async cookies(sessionId: string): Promise<ExportedCookie[]> {
    const body = await this.http.requestJson<{ cookies: ExportedCookie[] }>(
      `/v1/sessions/${sessionId}/cookies`
    );
    return body.cookies;
  }

  /** A3 evidence: export the session's completed spans as a trace artifact. */
  async trace(sessionId: string): Promise<ArtifactRef> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/trace`, { method: 'POST' });
  }

  /**
   * A3 evidence: capture the page's current HTML as an artifact (NOT
   * redacted). Under the service's inline budget the response carries the
   * bytes as `inline.contentBase64`; above it, only the descriptor comes
   * back and the bytes must be fetched via `artifact()`.
   */
  async html(
    sessionId: string,
    pageId: string
  ): Promise<ArtifactRef & { inline?: { contentBase64: string; byteSize?: number } }> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/html`, {
      method: 'POST',
    });
  }

  /**
   * Fetch a stored artifact. The GET route returns `contentBase64` with the
   * metadata; callers that prefer the descriptor alone can ignore it.
   */
  async artifact(
    sessionId: string,
    artifactId: string
  ): Promise<{ metadata: ArtifactRef; contentBase64?: string }> {
    const body = await this.http.requestJson<{
      metadata: ArtifactRef;
      contentBase64?: string;
    }>(`/v1/sessions/${sessionId}/artifacts/${artifactId}`);
    return {
      metadata: body.metadata,
      ...(body.contentBase64 !== undefined ? { contentBase64: body.contentBase64 } : {}),
    };
  }

  /** A3/network summary: replay retained session events, oldest first per ledger. */
  async events(sessionId: string, type?: string): Promise<Array<Record<string, unknown>>> {
    const query = type !== undefined ? `?type=${encodeURIComponent(type)}` : '';
    const body = await this.http.requestJson<{ events: Array<Record<string, unknown>> }>(
      `/v1/sessions/${sessionId}/events/replay${query}`
    );
    return body.events;
  }

  /** Structured native form filling; choose an operation ID before dispatch. */
  async autofill(
    sessionId: string,
    pageId: string,
    request: AutofillRequest,
    options: MutationOptions = {}
  ): Promise<AutofillReport> {
    const expectedFields = request.fields.length;
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/autofill`, {
      method: 'POST',
      body: request,
      ...options,
      timeoutMs: Math.min(240000, request.policy?.timeoutMs ?? 240000) + 30000,
      parseResponse: (input) => parseAutofillReport(input, expectedFields),
    });
  }

  async plan(
    sessionId: string,
    pageId: string,
    actions: Array<Record<string, unknown>>,
    options: MutationOptions = {}
  ): Promise<PlanReport> {
    const expectedSteps = actions.length;
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/plan`, {
      method: 'POST',
      body: { actions },
      ...options,
      parseResponse: (input) => parsePlanReport(input, expectedSteps),
    });
  }

  /** TD-BROWSER-8: self-contained snapshot payload for one-shot LLM reasoning. */
  async snapshot(
    sessionId: string,
    pageId: string,
    bounds?: { maxElements?: number; maxBytes?: number }
  ): Promise<PageSnapshot> {
    const query = new URLSearchParams();
    if (bounds?.maxElements !== undefined) query.set('maxElements', String(bounds.maxElements));
    if (bounds?.maxBytes !== undefined) query.set('maxBytes', String(bounds.maxBytes));
    const qs = query.toString();
    return this.http.requestJson(
      `/v1/sessions/${sessionId}/pages/${pageId}/snapshot${qs ? `?${qs}` : ''}`
    );
  }

  async navigate(
    sessionId: string,
    pageId: string,
    request: NavigationRequest,
    options: MutationOptions = {}
  ): Promise<NavigationResponse> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/navigate`, {
      ...options,
      method: 'POST',
      body: request,
    });
  }

  async observe(
    sessionId: string,
    pageId: string,
    request: ObservationRequest = {}
  ): Promise<ObservationResponse> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/observe`, {
      method: 'POST',
      body: request,
    });
  }

  async executeAction(
    sessionId: string,
    pageId: string,
    request: ActionRequest,
    options: MutationOptions = {}
  ): Promise<ActionResult> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/act`, {
      ...options,
      method: 'POST',
      body: request,
    });
  }

  async screenshot(
    sessionId: string,
    pageId: string,
    request: ScreenshotRequest = {}
  ): Promise<ArtifactRef> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/screenshot`, {
      method: 'POST',
      body: request,
    });
  }

  async extract(
    sessionId: string,
    pageId: string,
    request: ExtractRequest
  ): Promise<ExtractResult> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/extract`, {
      method: 'POST',
      body: request,
    });
  }

  async pdf(sessionId: string, pageId: string, request: PdfRequest = {}): Promise<ArtifactRef> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/pdf`, {
      method: 'POST',
      body: request,
    });
  }

  /**
   * Ask the service to navigate to a URL and capture a download as an
   * artifact. The session must have been created with downloads allowed
   * (DOWNLOAD_BLOCKED otherwise).
   */
  async download(
    sessionId: string,
    pageId: string,
    request: { url: string; filename?: string }
  ): Promise<ArtifactRef> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/download`, {
      method: 'POST',
      body: request,
    });
  }

  /**
   * Collect an intercepted download by filename (as reported by the page's
   * download events) and return its artifact reference.
   */
  async collectDownload(sessionId: string, pageId: string, filename: string): Promise<ArtifactRef> {
    return this.http.requestJson(
      `/v1/sessions/${sessionId}/pages/${pageId}/downloads/${encodeURIComponent(filename)}`,
      { method: 'POST' }
    );
  }
}

/**
 * AgentBrowser SDK Client
 */
export class AgentBrowserClient {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly sessions: SessionsClient;
  private customHeaders: Record<string, string>;
  private readonly http: HttpClient;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = options.baseUrl || 'http://localhost:5709';
    this.timeout = options.timeout || 30000;
    this.customHeaders = {
      ...(options.apiKey !== undefined ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      ...options.headers,
    };

    this.http = new HttpClient(this.baseUrl, this.timeout, this.customHeaders);
    this.sessions = new SessionsClient(this.http);
  }

  /**
   * Service health summary (GET /health). Never requires authentication.
   */
  async health(): Promise<{
    status: string;
    version?: string;
    uptime?: number;
    timestamp?: string;
  }> {
    return this.http.requestJson('/health');
  }

  /**
   * Liveness probe (GET /health/live).
   */
  async healthLive(): Promise<{ status: string; timestamp?: string }> {
    return this.http.requestJson('/health/live');
  }

  /**
   * Readiness probe (GET /health/ready). With a bearer key the response
   * includes engine and capability detail; without one it is a
   * disclosure-free readiness statement.
   */
  async healthReady(): Promise<{
    status: string;
    engine?: string;
    version?: string;
    capabilities?: unknown;
  }> {
    return this.http.requestJson('/health/ready');
  }

  /**
   * Set default headers for all requests
   */
  setHeaders(headers: Record<string, string>): void {
    Object.assign(this.customHeaders, headers);
  }
}
