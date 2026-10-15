import type {
  OperationReplay,
  OperatorApprovalView,
  OutcomeRunReport,
  OutcomeRunRequest,
  PlanReport,
} from '@agentbrowser/protocol';
import {
  createOutcomeRunReportParser,
  createPlanReportParser,
  INTERACTION_GUIDANCE,
  parseAutofillReport,
  parseOperationReplay,
  parseOperatorApprovalView,
  SELF_ADMITTING_ROUTE_SEGMENTS,
  type SnapshotControl,
  validateApplicationReview,
  validateCookieHandoffRequest,
  validateOperatorApprovalDecision,
} from '@agentbrowser/protocol';
/**
 * AgentBrowser TypeScript SDK Client
 *
 * Provides a fluent TypeScript client API for interacting with
 * the AgentBrowser REST API.
 */

import type {
  AgentMode,
  ApplicationDiscovery,
  ApplicationExecuteRequest,
  ApplicationOperationResult,
  ApplicationReviewRequest,
  AutofillReport,
  AutofillRequest,
  ControlView,
  CookieHandoffRequest,
  DELIVERED_ACTION_TYPES,
  OperationRecord,
  RunCursor,
  SessionRequest,
} from '@agentbrowser/protocol';

/** Event replay envelope (protocol single source, ADR-015). `oldestSeq`/`gap`
 * are present on paged responses from servers that report eviction gaps. */
export type {
  ApplicationBinding,
  ApplicationDiscovery,
  ApplicationExecuteRequest,
  ApplicationOperationResult,
  ApplicationReviewRequest,
  AutofillReport,
  AutofillRequest,
  ControlView,
  OperationRecord,
  OutcomeRunReport,
  OutcomeRunRequest,
  RunCursor,
  SessionEventsPage,
} from '@agentbrowser/protocol';

export interface MutationOptions {
  operationId?: string;
}

export interface ClientOptions {
  baseUrl?: string;
  timeout?: number;
  headers?: Record<string, string>;
  /** Bearer API key; sent as Authorization on every request. */
  apiKey?: string;
  /**
   * Caller cancellation: read at the start of each request. An aborted signal abandons the
   * request with `CANCELLED` (outcome may be unknown for a write; reconcile by operationId). A
   * hook, not a signal, so one client can serve concurrent callers (the MCP server scopes it
   * per tool call).
   */
  requestSignal?: () => AbortSignal | undefined;
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

export type SessionResponse = import('@agentbrowser/protocol').SessionView;

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
  reason?: import('@agentbrowser/protocol').NavigationFailureReason;
}

export type { ObservationRequest, ScreenshotRequest } from '@agentbrowser/protocol';

import type {
  ObservationRequest,
  ScreenshotRequest,
  SessionEventsPage,
} from '@agentbrowser/protocol';
import { validateObservationRequest, validateScreenshotRequest } from '@agentbrowser/protocol';

/** Canonical observation response, shared with REST and MCP output schemas. */
export type ObservationResponse = import('@agentbrowser/protocol').PageState;

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
  /** Complete compact JSON response budget in UTF-8 bytes, bounded by the server ceiling. */
  maxBytes?: number;
  /** JSON Schema constraining the extraction (format: 'schema' only). */
  schema?: Record<string, unknown>;
  /** Repeating-structure selectors (format: 'records' only). */
  records?: { container: string; fields: Record<string, string>; limit?: number };
}

export type { DeliveredExtractFormat } from '@agentbrowser/protocol';
// ADR-015 single-source-of-truth re-exports: surfaces (CLI, MCP) import
// these from the SDK rather than redeclaring them.
export {
  DELIVERED_EXTRACT_FORMATS,
  formatErrorForUser,
  navigationFailureDetail,
  parseAutofillRequest,
  parseExtractMaxBytesText,
  parseRef,
  REF_PATTERN,
  UsageError,
} from '@agentbrowser/protocol';

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

export type { ArtifactRef } from '@agentbrowser/protocol';

import type { ArtifactRef } from '@agentbrowser/protocol';

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
  /**
   * Opt-in minted custom controls (controls: true): PROJECTED from the same
   * single observation and budgeted separately from fields, so neither can
   * cut the other; truncation of the list is disclosed via
   * controlsProjection (matched < total). SnapshotControl is declared once
   * in @agentbrowser/protocol (ADR-015).
   */
  controls?: SnapshotControl[];
  /** matched = returned, total = minted; matched < total = truncated list. */
  controlsProjection?: { matched: number; total: number };
  truncated?: boolean;
  /**
   * True when the whole-page ariaSnapshot budget was exceeded and `fields`
   * came from a DOM-tag-only fallback: roles are bare HTML tags and any
   * custom widget with no native form control (e.g. a div-based combobox)
   * is entirely absent, even though `fields` looks structurally identical
   * either way. Retry with a larger snapshotTimeoutMs on the session.
   */
  degraded?: boolean;
  /** Why `degraded` is set, when it is. */
  degradedReason?: import('@agentbrowser/protocol').PageState['degradedReason'];
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
    private readonly headers: Record<string, string>,
    private readonly requestSignal?: () => AbortSignal | undefined
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
      // Self-admitting route families (control, operations, application)
      // carry their operation identity in their own contracts; the server
      // ignores the header on them. Deriving one here would mint a random
      // UUID, poison error details with a phantom ID, and make the replay
      // guard reject legitimate application replays whose recorded
      // operation ID can never equal a locally minted UUID.
      !SELF_ADMITTING_ROUTE_SEGMENTS.some((segment) => path.includes(segment)) &&
      init.method &&
      init.method !== 'GET'
        ? (init.operationId ?? this.headers['x-agentbrowser-operation-id'] ?? crypto.randomUUID())
        : undefined;
    const controller = new AbortController();
    const callerSignal = this.requestSignal?.();
    const cancelled = () => callerSignal?.aborted === true;
    const cancel = () => controller.abort();
    const timeoutId = setTimeout(() => controller.abort(), init.timeoutMs ?? this.timeoutMs);
    try {
      if (callerSignal !== undefined) {
        if (callerSignal.aborted) throw new Error('cancelled before dispatch');
        callerSignal.addEventListener('abort', cancel, { once: true });
      }
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

      const result: unknown = await response.json();
      const invalidResponse = () =>
        new AgentBrowserError(
          'INVALID_RESPONSE',
          `Invalid operation response. ${INTERACTION_GUIDANCE.uncertainWrite}`,
          false,
          operationId ? { operationId } : undefined
        );
      const replayShaped =
        typeof result === 'object' &&
        result !== null &&
        !Array.isArray(result) &&
        Object.hasOwn(result, 'replay') &&
        (result as { replay?: unknown }).replay === true;
      if (operationId && replayShaped) {
        let replay: OperationReplay;
        try {
          replay = parseOperationReplay(result);
        } catch {
          throw invalidResponse();
        }
        if (replay.operation.operationId !== operationId) throw invalidResponse();
        throw new AgentBrowserError(
          'OPERATION_RECORDED',
          'Operation already recorded; reconcile its status before taking further action',
          false,
          { operationId, operation: replay.operation }
        );
      }
      if (init.parseResponse) {
        try {
          return init.parseResponse(result);
        } catch {
          throw invalidResponse();
        }
      }
      return result as T;
    } catch (error) {
      if (cancelled()) {
        // Caller cancellation: a write may already have run, so this is uncertain, never a
        // success and never safe to replay blindly.
        throw new AgentBrowserError(
          'CANCELLED',
          'Request cancelled; outcome may be unknown',
          false,
          operationId ? { operationId } : undefined
        );
      }
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
      callerSignal?.removeEventListener('abort', cancel);
    }
  }
}

/** Bind the private review response to the requested approval identity. */
function approvalViewParser(tokenId: string): (input: unknown) => OperatorApprovalView {
  return (input) => {
    const view = parseOperatorApprovalView(input);
    if (view.tokenId !== tokenId) throw new Error('Approval identity mismatch');
    return view;
  };
}

/**
 * Sessions API client
 */
/** TD-BROWSER-16 (ADR-025 s3): the completed cookie handoff — counts only, never values. */
export interface CookieHandoffResult {
  sessionId: string;
  credentialSource: 'operator';
  domains: string[];
  counts: Record<string, number>;
  lease?: { hosts: string[]; expiresAt: number; maxActions: number; remainingActions: number };
}

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
  /** Private action projection; requires an authenticated operator. */
  async approval(sessionId: string, tokenId: string): Promise<OperatorApprovalView> {
    return this.http.requestJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(tokenId)}`,
      {
        parseResponse: approvalViewParser(tokenId),
      }
    );
  }
  async decideApproval(
    sessionId: string,
    tokenId: string,
    decision: 'approve' | 'deny',
    options: MutationOptions = {}
  ): Promise<OperatorApprovalView> {
    const checked = validateOperatorApprovalDecision({ decision });
    if (!checked.ok)
      throw new AgentBrowserError(
        'INVALID_REQUEST',
        'Approval decision must be approve or deny',
        false
      );
    return this.http.requestJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(tokenId)}`,
      {
        method: 'POST',
        body: checked.value,
        ...options,
        parseResponse: approvalViewParser(tokenId),
      }
    );
  }
  /** Operator: bind an application adapter to a resource while the human owns the session. */
  async applicationBind(
    sessionId: string,
    binding: { adapter: string; resource: string }
  ): Promise<{ adapter: string; resource: string }> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/application`, {
      method: 'PUT',
      body: binding,
    });
  }
  /**
   * Operator: drop the binding. Like bind, this requires the human to own
   * the session - it takes control as a side effect (bumping the control
   * epoch and invalidating a prepared review) even when nothing is bound.
   */
  async applicationUnbind(sessionId: string): Promise<{ unbound: true }> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/application`, { method: 'DELETE' });
  }
  /** The bound adapter's operations, or null when nothing is bound. */
  async applicationDiscover(sessionId: string): Promise<ApplicationDiscovery | null> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/application`);
  }
  /** Allocate a pending operator review. A lost response is not automatically retried. */
  async applicationReview(
    sessionId: string,
    request: ApplicationReviewRequest
  ): Promise<OperatorApprovalView> {
    const checked = validateApplicationReview(request);
    if (!checked.ok)
      throw new AgentBrowserError('INVALID_REQUEST', 'Invalid application review request', false);
    return this.http.requestJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}/application/reviews`,
      { method: 'POST', body: checked.value, parseResponse: parseOperatorApprovalView }
    );
  }
  /**
   * Dispatch one application operation. Writes need operationId +
   * expectedVersion; a repeated operationId returns the recorded
   * operation (`replay: true`) instead of re-executing - the retry-safe
   * path. Read operations must not carry either identity.
   */
  async applicationExecute(
    sessionId: string,
    request: ApplicationExecuteRequest
  ): Promise<ApplicationOperationResult> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/application/execute`, {
      method: 'POST',
      body: request,
    });
  }
  /** Read one application receipt by operation ID; null when the adapter has none. */
  async applicationReceipt(sessionId: string, operationId: string): Promise<unknown> {
    return this.http.requestJson(
      `/v1/sessions/${sessionId}/application/receipts/${encodeURIComponent(operationId)}`
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

  /**
   * A3/network summary: replay retained session events, oldest first per
   * ledger. The undefined/string form is the legacy array-returning shape.
   */
  async events(sessionId: string, type?: string): Promise<Array<Record<string, unknown>>>;
  /**
   * Replay retained session events. Object selectors always resolve to the
   * paging envelope `{events, nextCursor}` — the route answers with that
   * shape for type-only and limit-only queries too, and a bare array here
   * made limit-only callers crash on `envelope.events.map`.
   */
  async events(
    sessionId: string,
    options: { type?: string; since?: number; limit?: number }
  ): Promise<SessionEventsPage>;
  async events(
    sessionId: string,
    selector?: string | { type?: string; since?: number; limit?: number }
  ): Promise<Array<Record<string, unknown>> | SessionEventsPage> {
    let query = '';
    if (selector === undefined || typeof selector === 'string') {
      query =
        selector !== undefined && selector !== '' ? `?type=${encodeURIComponent(selector)}` : '';
    } else {
      const params = new URLSearchParams();
      if (selector.type !== undefined) params.set('type', selector.type);
      if (selector.since !== undefined) params.set('since', String(selector.since));
      if (selector.limit !== undefined) params.set('limit', String(selector.limit));
      query = params.size > 0 ? `?${params.toString()}` : '';
    }
    const body = await this.http.requestJson<{
      events: Array<Record<string, unknown>>;
      nextCursor?: number;
      oldestSeq?: number;
      gap?: boolean;
    }>(`/v1/sessions/${sessionId}/events/replay${query}`);
    // No default parameter: an explicitly-undefined argument must keep the
    // legacy array shape (a default `= {}` would silently turn it into the
    // paging envelope and break overload-1 callers at runtime).
    if (selector === undefined || typeof selector === 'string') return body.events;
    // oldestSeq/gap are paged-only and absent from older servers.
    return {
      events: body.events,
      nextCursor: body.nextCursor ?? -1,
      ...(typeof body.oldestSeq === 'number' ? { oldestSeq: body.oldestSeq } : {}),
      ...(typeof body.gap === 'boolean' ? { gap: body.gap } : {}),
    };
  }

  /**
   * TD-BROWSER-16 (ADR-025 s3): hand the operator's login cookies for the
   * given domains into this session. Without a decided approval token the
   * server refuses with APPROVAL_REQUIRED whose details carry
   * { tokenId, kind: 'cookie.handoff', sessionId, domains, counts } — relay
   * those to the operator, then retry with the token. Counts are numbers
   * only; values and cookie names never cross this boundary.
   */
  async cookieHandoff(
    sessionId: string,
    request: CookieHandoffRequest,
    options: MutationOptions = {}
  ): Promise<CookieHandoffResult> {
    const checked = validateCookieHandoffRequest(request);
    if (!checked.ok) {
      throw new AgentBrowserError(
        'INVALID_REQUEST',
        `Invalid handoff request: ${checked.issues
          .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
          .join('; ')}`,
        false
      );
    }
    return this.http.requestJson(`/v1/sessions/${encodeURIComponent(sessionId)}/cookies/handoff`, {
      method: 'POST',
      body: checked.value,
      ...options,
    });
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
    const parseResponse = createPlanReportParser(actions);
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/plan`, {
      method: 'POST',
      body: { actions },
      ...options,
      parseResponse,
    });
  }

  /** Execute one existing plan and verify its outcome through a trusted server source. */
  async outcome(
    sessionId: string,
    pageId: string,
    request: OutcomeRunRequest,
    options: MutationOptions = {}
  ): Promise<OutcomeRunReport> {
    const parseResponse = createOutcomeRunReportParser(request);
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/outcomes`, {
      method: 'POST',
      body: request,
      ...options,
      parseResponse,
    });
  }

  /** TD-BROWSER-8: self-contained snapshot payload for one-shot LLM reasoning. */
  async snapshot(
    sessionId: string,
    pageId: string,
    bounds?: { maxElements?: number; maxBytes?: number; controls?: boolean }
  ): Promise<PageSnapshot> {
    const query = new URLSearchParams();
    if (bounds?.maxElements !== undefined) query.set('maxElements', String(bounds.maxElements));
    if (bounds?.maxBytes !== undefined) query.set('maxBytes', String(bounds.maxBytes));
    if (bounds?.controls === true) query.set('controls', 'true');
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
    const checked = validateObservationRequest(request);
    if (!checked.ok)
      throw new AgentBrowserError(
        'INVALID_REQUEST',
        checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
        false
      );
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
    const checked = validateScreenshotRequest(request);
    if (!checked.ok)
      throw new AgentBrowserError(
        'INVALID_REQUEST',
        checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
        false
      );
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
   * Collect an intercepted download by ID (preferred) or unique filename.
   * IDs come from download events; ambiguous filenames fail. Returns the stored artifact.
   */
  async collectDownload(
    sessionId: string,
    pageId: string,
    downloadIdOrFilename: string
  ): Promise<ArtifactRef> {
    return this.http.requestJson(
      `/v1/sessions/${sessionId}/pages/${pageId}/downloads/${encodeURIComponent(downloadIdOrFilename)}`,
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

    this.http = new HttpClient(
      this.baseUrl,
      this.timeout,
      this.customHeaders,
      options.requestSignal
    );
    this.sessions = new SessionsClient(this.http);
  }

  /**
   * TD-BROWSER-15 phase 5: the loaded policy summary (GET /v1/policy). The
   * capability summary is decided for a default session of the caller's
   * tenant; the response says so.
   */
  async policy(): Promise<{
    policyVersion: string;
    limits?: Record<string, number>;
    summaryFor: string;
    capabilities: Record<string, { allowed: boolean; reason?: string; ruleMatched?: string }>;
    unconditional?: string;
  }> {
    return this.http.requestJson('/v1/policy');
  }

  /**
   * TD-BROWSER-15 phase 5: ask what the loaded policy would decide
   * (POST /v1/policy/check). Answers come by enumeration, never by DNS
   * resolution; a hostname gets one answer per class set.
   */
  async policyCheck(request: {
    action: string;
    target?: string;
    url?: string;
    context?: { effect?: string; matchedRule?: string };
  }): Promise<{
    action: string;
    target?: string;
    answers: Array<{
      classSet: string;
      answer: {
        kind: string;
        decision?: { allowed: boolean; reason?: string; ruleMatched?: string };
      };
    }>;
  }> {
    return this.http.requestJson('/v1/policy/check', { method: 'POST', body: request });
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
