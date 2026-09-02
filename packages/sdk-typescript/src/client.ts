/**
 * AgentBrowser TypeScript SDK Client
 *
 * Provides a fluent TypeScript client API for interacting with
 * the AgentBrowser REST API.
 */

import type { DELIVERED_ACTION_TYPES } from '@agentbrowser/protocol';

export interface ClientOptions {
  baseUrl?: string;
  timeout?: number;
  headers?: Record<string, string>;
  /** Bearer API key; sent as Authorization on every request. */
  apiKey?: string;
}

export interface SessionRequest {
  tenantId: string;
  engine?: string;
  viewport?: { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  headless?: boolean;
  ttlMs?: number;
  idleTimeoutMs?: number;
  /** Seed cookies to reuse an already-authenticated session (skip SSO login). */
  cookies?: SessionCookie[];
}

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

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
  format: 'text' | 'markdown' | 'links' | 'tables' | 'forms' | 'jsonld';
}

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
 * Sessions API client
 */
export class SessionsClient {
  constructor(
    private baseUrl: string,
    private timeout: number,
    private headers: Record<string, string>,
    private requestFn: (url: string, options: RequestInit) => Promise<Response>
  ) {}

  async create(request: SessionRequest): Promise<SessionResponse> {
    const response = await this.requestFn(`${this.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify(request),
    });

    return this.handleResponse(response);
  }

  async get(sessionId: string): Promise<SessionResponse> {
    const response = await this.requestFn(`${this.baseUrl}/v1/sessions/${sessionId}`, {
      method: 'GET',
      headers: this.headers,
    });

    return this.handleResponse(response);
  }

  async list(): Promise<SessionResponse[]> {
    const response = await this.requestFn(`${this.baseUrl}/v1/sessions`, {
      method: 'GET',
      headers: this.headers,
    });

    const data = await this.handleResponse<{ sessions: SessionResponse[] }>(response);
    return data.sessions;
  }

  async close(sessionId: string): Promise<void> {
    const response = await this.requestFn(`${this.baseUrl}/v1/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: this.headers,
    });

    await this.handleResponse(response);
  }

  async createPage(sessionId: string): Promise<PageResponse> {
    const response = await this.requestFn(`${this.baseUrl}/v1/sessions/${sessionId}/pages`, {
      method: 'POST',
      headers: this.headers,
    });

    return this.handleResponse(response);
  }

  async getPage(sessionId: string, pageId: string): Promise<PageResponse> {
    const response = await this.requestFn(
      `${this.baseUrl}/v1/sessions/${sessionId}/pages/${pageId}`,
      {
        method: 'GET',
        headers: this.headers,
      }
    );

    return this.handleResponse(response);
  }

  async closePage(sessionId: string, pageId: string): Promise<void> {
    const response = await this.requestFn(
      `${this.baseUrl}/v1/sessions/${sessionId}/pages/${pageId}`,
      {
        method: 'DELETE',
        headers: this.headers,
      }
    );

    await this.handleResponse(response);
  }

  /** TD-BROWSER-6: scoped cookie export — the read half of the credential handoff loop. */
  async cookies(sessionId: string): Promise<ExportedCookie[]> {
    const response = await this.requestFn(`${this.baseUrl}/v1/sessions/${sessionId}/cookies`, {
      headers: this.headers,
    });
    const body = (await this.handleResponse(response)) as { cookies: ExportedCookie[] };
    return body.cookies;
  }

  async navigate(
    sessionId: string,
    pageId: string,
    request: NavigationRequest
  ): Promise<NavigationResponse> {
    const response = await this.requestFn(
      `${this.baseUrl}/v1/sessions/${sessionId}/pages/${pageId}/navigate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(request),
      }
    );

    return this.handleResponse(response);
  }

  async observe(
    sessionId: string,
    pageId: string,
    request: ObservationRequest = {}
  ): Promise<ObservationResponse> {
    const response = await this.requestFn(
      `${this.baseUrl}/v1/sessions/${sessionId}/pages/${pageId}/observe`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(request),
      }
    );

    return this.handleResponse(response);
  }

  async executeAction(
    sessionId: string,
    pageId: string,
    request: ActionRequest
  ): Promise<ActionResult> {
    const response = await this.requestFn(
      `${this.baseUrl}/v1/sessions/${sessionId}/pages/${pageId}/act`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(request),
      }
    );

    return this.handleResponse(response);
  }

  async screenshot(
    sessionId: string,
    pageId: string,
    request: ScreenshotRequest = {}
  ): Promise<ArtifactRef> {
    const response = await this.requestFn(
      `${this.baseUrl}/v1/sessions/${sessionId}/pages/${pageId}/screenshot`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(request),
      }
    );

    return this.handleResponse(response);
  }

  async extract(
    sessionId: string,
    pageId: string,
    request: ExtractRequest
  ): Promise<ExtractResult> {
    const response = await this.requestFn(
      `${this.baseUrl}/v1/sessions/${sessionId}/pages/${pageId}/extract`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(request),
      }
    );

    return this.handleResponse(response);
  }

  async pdf(sessionId: string, pageId: string, request: PdfRequest = {}): Promise<ArtifactRef> {
    const response = await this.requestFn(
      `${this.baseUrl}/v1/sessions/${sessionId}/pages/${pageId}/pdf`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(request),
      }
    );

    return this.handleResponse(response);
  }

  private async handleResponse<T>(response: Response): Promise<T> {
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
      this.baseUrl,
      this.timeout,
      this.customHeaders,
      this.request.bind(this)
    );
  }

  /**
   * Set default headers for all requests
   */
  setHeaders(headers: Record<string, string>): void {
    Object.assign(this.customHeaders, headers);
  }

  /**
   * Make an HTTP request with timeout
   */
  private async request(url: string, options: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new AgentBrowserError('TIMEOUT', 'Request timeout', false);
      }

      throw error;
    }
  }
}
