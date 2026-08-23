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
  role: string;
  name?: string;
  value?: string;
  required?: boolean;
  visible: boolean;
  enabled: boolean;
  focused?: boolean;
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
 * Engine element target
 */
export interface EngineTarget {
  ref: string;
}

/**
 * Engine action (unified type)
 */
export interface EngineAction {
  type: string;
  target?: EngineTarget;
  [key: string]: unknown;
}

/**
 * Action effect from engine
 */
export interface ActionEffect {
  actionId: string;
  startTimestamp: string;
  endTimestamp: string;
  oldRevision: number;
  newRevision: number;
  result: unknown;
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
  | 'page navigated'
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
   * Extract data from page
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
