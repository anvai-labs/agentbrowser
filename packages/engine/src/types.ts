/**
 * BrowserEngine interface and engine-neutral types
 *
 * This package defines the contract that all browser engine implementations
 * must follow. This is the source of truth for engine integration.
 */

import type {
  ActionRequest,
  ActionResult,
  ArtifactRef,
  ElementTarget,
  EngineCapabilities,
  ObservationRequest,
  PageState,
  PdfRequest,
  ScreenshotRequest,
  Viewport,
} from '@agentbrowser/protocol';

// Re-export protocol types used in engine interface
export type {
  EngineCapabilities,
  Viewport,
  PageState,
  ActionRequest,
  ActionResult,
  ArtifactRef,
  ObservationRequest,
  ScreenshotRequest,
  PdfRequest,
};

/**
 * Engine session creation options
 */
export interface EngineSessionOptions {
  viewport?: Viewport;
  locale?: string;
  timezoneId?: string;
  headless?: boolean;
  /**
   * Seed cookies injected into the session's context before first navigation.
   * Lets a caller reuse an already-authenticated session (e.g. to skip an
   * SSO / device-trust login the automation browser cannot satisfy itself).
   */
  cookies?: NormalizedCookie[];
  /**
   * Per-session egress policy (overrides the engine's root policy). Engines
   * that can intercept network traffic enforce it as a choke point over
   * every outbound request, redirects and subresources included.
   */
  requestPolicy?: RequestPolicy;
}

/**
 * Egress policy port for engines. Satisfied structurally by the policy
 * package's NetworkPolicy and SessionHostPolicy - engines stay
 * dependency-free (dependency inversion).
 *
 * Implementations MUST treat the verdict as a pure function of hostname:
 * engines memoize verdicts per host.
 *
 * Throw contract (ADR-015 B9): every gate blocks by THROWING - the thrown
 * error should carry the policy's code (e.g. POLICY_DENIED) and the rule
 * that fired, so engines can surface a typed refusal. Returning without
 * throwing means ALLOW.
 */
export interface RequestPolicy {
  checkRequest(request: { hostname: string; url: string }): Promise<void>;
  /**
   * Optional response-size gate enforced at the choke point (bytes).
   * Implementations throw to block an oversized response.
   */
  checkResponse?(response: { headers: Record<string, string> }): Promise<void>;
  /**
   * Optional actual-byte gate for responses without content-length
   * (chunked/streamed): the choke point buffers the body (bounded by the
   * policy's own cap) and reports the true size. Throw to block.
   */
  checkBodySize?(bytes: number): Promise<void>;
  /**
   * Optional DNS-rebinding gate: engines that resolve hostnames call this
   * with EVERY resolved address before connecting. Verdict caches must key
   * on the resolved set so a changed resolution re-validates. Throw to
   * block.
   */
  checkResolvedAddresses?(addresses: string[]): Promise<void>;
}

/**
 * New page creation options
 */
export interface NewPageOptions {
  viewport?: Viewport;
}

/**
 * Navigation request
 */
export interface NavigationRequest {
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

/**
 * Navigation result
 */
export interface NavigationResult {
  status: 'success' | 'timeout' | 'blocked';
  url: string;
  redirectChain: string[];
}

/**
 * Raw page state from engine (before normalization)
 */
export interface RawPageState {
  url: string;
  title: string;
  status: 'loading' | 'interactive' | 'complete';
  content: string;
  elements: RawElement[];
  metadata?: Record<string, unknown>;
}

/**
 * Raw element from engine
 */
export interface RawElement {
  /** The engine's own element ref, when the engine keys elements by ref. */
  ref?: string;
  role: string;
  name?: string;
  value?: string;
  required?: boolean;
  visible: boolean;
  enabled: boolean;
  focused?: boolean;
  /** Risk classification carried through to normalized observations. */
  risk?:
    | 'read'
    | 'write-local'
    | 'external-message'
    | 'transaction'
    | 'account-security'
    | 'destructive';
  bounds?: ElementBounds;
  attributes?: Record<string, string>;
}

/**
 * Element bounds
 */
export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Engine element target - ADR-015: the protocol's ElementTarget is the
 * single declaration; this alias keeps the engine-facing name.
 */
export type EngineTarget = ElementTarget;

/**
 * Engine action (unified type)
 */
export interface EngineAction {
  type: string;
  target?: EngineTarget;
  [key: string]: unknown;
}

/**
 * Action effect from engine - ADR-015: the protocol's ActionResult is the
 * single declaration of the result shape; the engine interface extends it
 * with the engine-only `effect` tag instead of redeclaring the fields.
 */
export interface ActionEffect extends ActionResult {
  effect?: string;
}

/**
 * Extraction request
 */
export interface ExtractionRequest {
  schema?: Record<string, unknown>;
  selector?: string;
  format?: 'json' | 'markdown' | 'text' | 'html';
}

/**
 * Extraction result
 */
export interface ExtractionResult {
  data: unknown;
  evidence?: ExtractionEvidence[];
  warnings?: string[];
  modelUsed?: string;
  tokenUsage?: { input: number; output: number };
}

/**
 * Extraction evidence
 */
export interface ExtractionEvidence {
  url: string;
  revision: number;
  ref?: string;
  text?: string;
  hash?: string;
}

/**
 * Engine event types
 */
export type EngineEventType =
  | 'page.created'
  | 'page.destroyed'
  | 'page.navigated'
  | 'page.loaded'
  | 'page.crashed'
  | 'console.log'
  | 'console.error'
  | 'console.warning'
  | 'request.started'
  | 'request.finished'
  | 'request.failed'
  | 'download.created'
  | 'download.finished'
  | 'dialog.opened'
  | 'dialog.closed'
  | 'worker.created'
  | 'worker.destroyed';

/**
 * Engine event
 */
export interface EngineEvent {
  type: EngineEventType;
  timestamp: string;
  sessionId: string;
  pageId?: string;
  data?: Record<string, unknown>;
}

// ============================================================================
// BrowserEngine Interface (The Core Contract)
// ============================================================================

/**
 * BrowserEngine interface
 *
 * All browser engine implementations must implement this interface.
 * This is the source of truth for engine integration.
 */
export interface BrowserEngine {
  /**
   * Engine name (e.g., 'playwright-chromium', 'obscura')
   */
  readonly name: string;

  /**
   * Engine version
   */
  readonly version: string;

  /**
   * Get engine capabilities
   */
  capabilities(): Promise<EngineCapabilities>;

  /**
   * Create a new engine session
   */
  createSession(options: EngineSessionOptions): Promise<EngineSession>;

  /**
   * Restore session from snapshot (optional)
   */
  restoreSession?(snapshot: Uint8Array, options: EngineSessionOptions): Promise<EngineSession>;

  /**
   * Close engine and cleanup resources
   */
  close(): Promise<void>;
}

/**
 * Engine session interface
 */
export interface EngineSession {
  /**
   * Session ID
   */
  id: string;

  /**
   * Create a new page in this session
   */
  newPage(options?: NewPageOptions): Promise<EnginePage>;

  /**
   * Get all pages in this session
   */
  pages(): Promise<EnginePage[]>;

  /**
   * Get cookies from this session
   */
  cookies(): Promise<NormalizedCookie[]>;

  /**
   * Create snapshot for resume (optional)
   */
  snapshot?(): Promise<Uint8Array>;

  /**
   * Close session and cleanup
   */
  close(reason?: string): Promise<void>;
}

/**
 * Engine page interface
 */
export interface EnginePage {
  /**
   * Page ID
   */
  id: string;

  /**
   * Navigate to URL
   */
  navigate(request: NavigationRequest): Promise<NavigationResult>;

  /**
   * Observe page state
   */
  observe(request: ObservationRequest): Promise<RawPageState>;

  /**
   * Resolve target to element
   */
  resolve(target: EngineTarget): Promise<ResolvedTarget>;

  /**
   * Execute action
   */
  act(action: EngineAction): Promise<ActionEffect>;

  /**
   * Extract data from page.
   *
   * VESTIGIAL: extraction in the shipped stack is service-level (the
   * service observes the page and runs the extraction package's pure
   * functions over the raw state); no engine's implementation of this
   * method is consulted in production. Kept on the interface for
   * compatibility; do not build on it.
   */
  extract(request: ExtractionRequest): Promise<ExtractionResult>;

  /**
   * Capture screenshot
   */
  screenshot(request: ScreenshotRequest): Promise<ArtifactRef>;

  /**
   * Generate PDF (optional)
   */
  pdf?(request: PdfRequest): Promise<ArtifactRef>;

  /**
   * Get page events stream
   */
  events(): AsyncIterable<EngineEvent>;

  /**
   * Close page
   */
  close(): Promise<void>;
}

/**
 * Normalized cookie
 */
export interface NormalizedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

/**
 * Resolved target with fingerprint
 */
export interface ResolvedTarget {
  ref: string;
  fingerprint: string;
  role: string;
  name?: string;
  visible: boolean;
  enabled: boolean;
}
