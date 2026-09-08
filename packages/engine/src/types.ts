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
  OverlayBlocker,
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
  OverlayBlocker,
  ScreenshotRequest,
  PdfRequest,
};

/**
 * Engine session creation options
 */
export interface EngineSessionOptions {
  downloadPolicy?: { allow: boolean; maxBytes: number };
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
 * Engines recheck requests and DNS results before each fetch; no stale
 * hostname allow verdict may suppress resolved-address validation.
 *
 * Throw contract (ADR-015 B9): every gate blocks by THROWING - the thrown
 * error should carry the policy's code (e.g. POLICY_DENIED) and the rule
 * that fired, so engines can surface a typed refusal. Returning without
 * throwing means ALLOW.
 */
export interface RequestPolicy {
  checkRequest(request: { hostname: string; url: string }): Promise<void>;
  /** Redirect targets, excluding the initial request; throw before following. */
  checkRedirectChain?(requests: Array<{ url: string; hostname?: string }>): Promise<void>;
  /**
   * Optional response-size gate enforced at the choke point (bytes).
   * Implementations throw to block an oversized response.
   */
  checkResponse?(response: { headers: Record<string, string> }): Promise<void>;
  /**
   * Optional actual-byte gate for responses without content-length
   * (chunked/streamed): reports actual bytes. A buffered adapter's check
   * does NOT bound peak transport memory. Streaming transports call this
   * incrementally. Throw to block.
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
  /** Optional monotonic engine observation generation, including out-of-band DOM changes. */
  revision?: number;
  url: string;
  title: string;
  status: 'loading' | 'interactive' | 'complete';
  content: string;
  elements: RawElement[];
  /** Aggregated occluders, present only when the request included "overlays". */
  overlays?: OverlayBlocker[];
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
  /** Link destination, captured at observation time on role:"link" elements. */
  href?: string;
  /** True when the captured href exceeded the 2048-char capture limit. */
  hrefTruncated?: boolean;
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
  /**
   * Opt-in healing (F2): when the targeted control was replaced, re-observe
   * and act on the single role+name match. Engines that decline report the
   * refusal with candidate counts; live semantic-evidence mismatches are
   * never remapped.
   */
  remap?: boolean;
  [key: string]: unknown;
}

/**
 * Action effect from engine - ADR-015: the protocol's ActionResult is the
 * single declaration of the result shape; the engine interface extends it
 * with the engine-only `effect` tag instead of redeclaring the fields.
 */
export interface ActionEffect extends ActionResult {
  effect?: string;
  /** Present only when the engine healed a replaced target (F2). */
  remap?: { from: string; to: string };
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
  | 'download.failed'
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
  /** Consume a captured download by unique ID, or an unambiguous legacy filename. */
  takeDownload?(
    pageId: string,
    downloadId: string
  ): Promise<{ downloadId: string; filename: string; bytes: Uint8Array } | undefined>;
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

  /** Live document URL without creating an observation or changing refs. */
  getUrl?(): Promise<string>;

  /**
   * Wait until a CSS selector is visible. Optional primitive backing the
   * `selectorVisible` wait condition; engines without it degrade to
   * ENGINE_UNSUPPORTED at the service boundary.
   */
  waitForSelector?(selector: string, options?: { timeoutMs?: number }): Promise<void>;

  /**
   * Best-effort cached URL for page discovery. Synchronous: no browser I/O,
   * operation queue, observation, or ref changes. May lag navigation; omit
   * when unavailable or closed. Never use this cache for security decisions.
   */
  getCachedUrl?(): string | undefined;

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
  screenshot(request: ScreenshotRequest): Promise<CapturedArtifact>;

  /**
   * Generate PDF (optional)
   */
  pdf?(request: PdfRequest): Promise<CapturedArtifact>;

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
 * An ArtifactRef plus the actual captured bytes. The service builds the
 * real, artifact-store-backed ArtifactRef from these bytes (put() mints
 * its own artifactId/url) - the engine's artifactId/url fields above are
 * placeholders, never surfaced to a caller. bytesBase64 is not optional:
 * a capture method with no bytes to report should not implement
 * screenshot/pdf at all (pdf is already optional on EnginePage for
 * exactly this reason).
 *
 * PRODUCTION BUG this type exists to prevent recurring: the real
 * Playwright and Safari engines used to return bare ArtifactRef with no
 * bytes, and the service's Buffer.from(undefined ?? '', 'base64') dropped
 * the mismatch silently - every real screenshot/PDF was a 0-byte artifact,
 * caught by nothing (every prior service-level test ran against
 * FakeEngine, which happened to include the field despite the looser
 * `Promise<any>` it was typed with).
 */
export interface CapturedArtifact extends ArtifactRef {
  bytesBase64: string;
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
