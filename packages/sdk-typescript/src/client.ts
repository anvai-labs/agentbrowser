/**
 * AgentBrowser TypeScript SDK Client
 *
 * Provides a fluent TypeScript client API for interacting with
 * the AgentBrowser REST API.
 */

import type { DELIVERED_ACTION_TYPES, SessionRequest } from '@agentbrowser/protocol';

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
  }>;
  truncated: boolean;
  untrustedContent: boolean;
  /** Present only when the observation is truncated. */
  continuation?: { nextOrdinal: number; remaining: number };
}

/** The delivered action set, derived from the protocol source of truth. */
export type DeliveredAction = (typeof DELIVERED_ACTION_TYPES)[number];

export interface ActionRequest {
  action: DeliveredAction;
  /** Required for element-targeted actions; omitted for dialog actions. */
  target?: { ref: string };
  value?: string;
  /** Prompt answer for acceptDialog. */
  promptText?: string;
  options?: Record<string, unknown>;
  observe?: 'after' | 'none';
}

export interface ActionResult {
  status: string;
  actionId?: string;
  newRevision?: number;
  observation?: ObservationResponse;
}

export interface ExtractRequest {
  format: 'text' | 'markdown' | 'links' | 'tables' | 'forms' | 'jsonld' | 'schema';
  /** JSON Schema constraining the extraction (format: 'schema' only). */
  schema?: Record<string, unknown>;
}

// ADR-015 single-source-of-truth re-exports: surfaces (CLI, MCP) import
// these from the SDK rather than redeclaring them.
export { DELIVERED_EXTRACT_FORMATS, REF_PATTERN, parseRef } from '@agentbrowser/protocol';
export type { DeliveredExtractFormat } from '@agentbrowser/protocol';
export { UsageError, formatErrorForUser } from '@agentbrowser/protocol';

export interface ExtractResult {
  data: unknown;
  evidence: Array<{
    url: string;
    revision: number;
    ref?: string;
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
}

export class AgentBrowserError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false
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

  async requestJson<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...this.headers,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AgentBrowserError('TIMEOUT', 'Request timeout', false);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      let error: ApiError;
      try {
        const data = (await response.json()) as { error?: ApiError };
        error = data.error || {
          code: 'UNKNOWN_ERROR',
          message: 'Unknown error',
          retryable: false,
        };
      } catch {
        error = {
          code: 'UNKNOWN_ERROR',
          message: `HTTP ${response.status}: ${response.statusText}`,
          retryable: false,
        };
      }
      throw new AgentBrowserError(error.code, error.message, error.retryable);
    }

    return response.json() as Promise<T>;
  }
}

/**
 * Sessions API client
 */
export class SessionsClient {
  constructor(private readonly http: HttpClient) {}

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

  async createPage(sessionId: string): Promise<PageResponse> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages`, { method: 'POST' });
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

  /** A3 evidence: capture the page's current HTML as an artifact (NOT redacted). */
  async html(sessionId: string, pageId: string): Promise<ArtifactRef> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/html`, {
      method: 'POST',
    });
  }

  /** A3/network summary: replay retained session events, oldest first per ledger. */
  async events(sessionId: string, type?: string): Promise<Array<Record<string, unknown>>> {
    const query = type !== undefined ? `?type=${encodeURIComponent(type)}` : '';
    const body = await this.http.requestJson<{ events: Array<Record<string, unknown>> }>(
      `/v1/sessions/${sessionId}/events/replay${query}`
    );
    return body.events;
  }

  /** TD-BROWSER-8: execute a batched action plan; returns per-step results. */
  async plan(
    sessionId: string,
    pageId: string,
    actions: Array<Record<string, unknown>>
  ): Promise<{
    ok: boolean;
    completed: number;
    results: Array<{ step: number; ok: boolean; error?: string }>;
    mode?: string;
    error?: { code: string; message: string };
  }> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/plan`, {
      method: 'POST',
      body: { actions },
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
    request: NavigationRequest
  ): Promise<NavigationResponse> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/navigate`, {
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
    request: ActionRequest
  ): Promise<ActionResult> {
    return this.http.requestJson(`/v1/sessions/${sessionId}/pages/${pageId}/act`, {
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
}

/**
 * AgentBrowser SDK Client
 */
export class AgentBrowserClient {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly sessions: SessionsClient;
  private customHeaders: Record<string, string>;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = options.baseUrl || 'http://localhost:3000';
    this.timeout = options.timeout || 30000;
    this.customHeaders = {
      ...(options.apiKey !== undefined ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      ...options.headers,
    };

    this.sessions = new SessionsClient(
      new HttpClient(this.baseUrl, this.timeout, this.customHeaders)
    );
  }

  /**
   * Set default headers for all requests
   */
  setHeaders(headers: Record<string, string>): void {
    Object.assign(this.customHeaders, headers);
  }
}
