/**
 * Core type definitions for AgentBrowser protocol
 */

/**
 * Screenshot request options
 */
export interface ScreenshotRequest {
  fullPage?: boolean;
  maskSensitive?: boolean;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
}

/**
 * PDF request options
 */
export interface PdfRequest {
  landscape?: boolean;
  displayHeaderFooter?: boolean;
  printBackground?: boolean;
}

/**
 * Viewport dimensions for browser sessions
 */
export interface Viewport {
  width: number;
  height: number;
}

/**
 * Session creation request
 */
export interface SessionRequest {
  /** Engine selection; omitted = server default. */
  engine?: EngineType;
  /** Owning tenant; stamped onto the session for scoping and quotas. */
  tenantId?: string;
  ttlMs?: number;
  idleTimeoutMs?: number;
  viewport?: Viewport;
  locale?: string;
  timezoneId?: string;
  headless?: boolean;
  /**
   * Seed cookies injected into the session before first navigation, to reuse
   * an already-authenticated session (e.g. bypass an SSO / device-trust login
   * the automation browser cannot satisfy itself).
   */
  cookies?: SessionCookie[];
  policy?: SessionPolicy;
}

/**
 * A cookie to seed into a new session's browser context.
 */
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

/**
 * Engine type selection
 */
export type EngineType = 'playwright-chromium' | 'auto';

/**
 * Session policy configuration
 */
export interface SessionPolicy {
  allowedHosts: string[];
  blockedHosts?: string[];
  allowDownloads?: boolean;
  maxDownloadBytes?: number;
  approval?: ApprovalPolicy;
}

/**
 * Approval policy for actions
 */
export interface ApprovalPolicy {
  transactions?: 'allow' | 'deny' | 'required';
  externalMessages?: 'allow' | 'deny' | 'required';
}

/**
 * Session creation response
 */
export interface SessionResponse {
  sessionId: string;
  engine: EngineInfo;
  createdAt: string;
  ttlMs: number;
  idleTimeoutMs: number;
}

/**
 * Engine information
 */
export interface EngineInfo {
  name: string;
  version: string;
  capabilities: EngineCapabilities;
}

/**
 * Engine capabilities
 */
export interface EngineCapabilities {
  supportsScreenshots: boolean;
  supportsPdf: boolean;
  supportsDownloads: boolean;
  supportsUploads: boolean;
  supportsJavascript: boolean;
  supportsWebgl: boolean;
  supportsVideo: boolean;
  supportsPersistentStorage: boolean;
  supportsAccessibilityTree: boolean;
  supportsCdp: boolean;
  supportedObservationModes: ObservationMode[];
  supportedActionTypes: ActionType[];
  /**
   * TD-BROWSER-7: the engine's browser cannot run headless (real Safari via
   * safaridriver). Sessions created with `headless: true` still run headed;
   * service-level callers must reject explicit headless requests loudly
   * instead of relying on the engine.
   */
  alwaysHeaded?: boolean;
}

/**
 * Observation mode
 */
export type ObservationMode =
  | 'interactive'
  | 'content'
  | 'accessibility'
  | 'compact_dom'
  | 'visual';

/**
 * Action type
 */
export type ActionType =
  | 'navigate'
  | 'click'
  | 'hover'
  | 'fill'
  | 'type'
  | 'clear'
  | 'press'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'scroll'
  | 'wait'
  | 'upload'
  | 'download'
  | 'goBack'
  | 'goForward'
  | 'reload'
  | 'dismissDialog'
  | 'acceptDialog';

/**
 * Page state response
 */
export interface PageState {
  sessionId: string;
  pageId: string;
  revision: number;
  url: string;
  title: string;
  status: PageStatus;
  focusedRef?: string;
  summary?: string;
  elements: PageElement[];
  text?: string[];
  changes?: ElementChange[];
  truncated: boolean;
  untrustedContent: boolean;
  /**
   * Cursor for fetching the rest of a truncated observation, in stable
   * document order. Present only when truncated.
   */
  continuation?: ContinuationCursor;
}

/**
 * Points at the next element ordinal of a truncated observation and reports
 * how many elements remain.
 */
export interface ContinuationCursor {
  nextOrdinal: number;
  remaining: number;
}

/**
 * Page load status
 */
export type PageStatus = 'loading' | 'interactive' | 'complete';

/**
 * Page element representation
 */
export interface PageElement {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  required?: boolean;
  visible: boolean;
  enabled: boolean;
  focused?: boolean;
  risk?: ActionEffect;
}

/**
 * Element change for diffs
 */
export interface ElementChange {
  ref: string;
  change: 'added' | 'removed' | 'modified';
  properties: Record<string, { old: unknown; new: unknown }>;
}

/**
 * Action effect classification
 */
export type ActionEffect =
  | 'read'
  | 'write-local'
  | 'external-message'
  | 'transaction'
  | 'account-security'
  | 'destructive';

/**
 * Action request
 */
export interface ActionRequest {
  pageId: string;
  expectedRevision: number;
  action: SupportedAction;
  wait?: WaitCondition;
  observeAfter?: ObservationRequest;
  approvalToken?: string;
}

/**
 * Base action interface
 */
export interface Action {
  type: ActionType;
}

/**
 * Navigate action
 */
export interface NavigateAction extends Action {
  type: 'navigate';
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

/**
 * Click action
 */
export interface ClickAction extends Action {
  type: 'click';
  target: ElementTarget;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[];
}

/**
 * Element target
 */
export interface ElementTarget {
  ref: string;
}

/**
 * The stable element-reference grammar (ADR-004): `e<revision>_<ordinal>`.
 * Single source of truth (ADR-015): every surface derives from these
 * exports. `REF_PATTERN.source` must stay byte-for-byte stable — it is
 * embedded verbatim in the published OpenAPI and MCP schemas.
 */
export const REF_PATTERN = /^e\d+_\d+$/;

const REF_PARSE_PATTERN = /^e(\d+)_(\d+)$/;

/** Parse a ref into its revision and ordinal; null when malformed. */
export function parseRef(ref: string): { revision: number; ordinal: number } | null {
  const match = REF_PARSE_PATTERN.exec(ref);
  if (!match?.[1] || !match?.[2]) {
    return null;
  }
  return {
    revision: Number.parseInt(match[1], 10),
    ordinal: Number.parseInt(match[2], 10),
  };
}

/**
 * Extraction formats the stack delivers, in canonical order (ADR-015
 * SSOT; superset of the pre-SSOT lists — includes 'schema').
 */
export const DELIVERED_EXTRACT_FORMATS = [
  'text',
  'markdown',
  'links',
  'tables',
  'forms',
  'jsonld',
  'schema',
] as const;

export type DeliveredExtractFormat = (typeof DELIVERED_EXTRACT_FORMATS)[number];

/**
 * Fill action
 */
export interface FillAction extends Action {
  type: 'fill';
  target: ElementTarget;
  value: string;
  sensitive?: boolean;
}

/**
 * Select action
 */
export interface SelectAction extends Action {
  type: 'select';
  target: ElementTarget;
  values: string[];
}

/**
 * Scroll action
 */
export interface ScrollAction extends Action {
  type: 'scroll';
  target?: ElementTarget;
  deltaX?: number;
  deltaY?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
}

/**
 * Press action
 */
export interface PressAction extends Action {
  type: 'press';
  target?: ElementTarget;
  key: string;
}

/**
 * Wait action
 */
export interface WaitAction extends Action {
  type: 'wait';
  condition: WaitCondition;
}

/**
 * Tagged union of actions accepted by `ActionRequest`.
 *
 * Mirrors `ActionSchema` in schemas.ts so that narrowing on `action.type`
 * yields the correct per-action parameters.
 */
export type SupportedAction =
  | NavigateAction
  | ClickAction
  | FillAction
  | SelectAction
  | ScrollAction
  | PressAction
  | WaitAction
  | AcceptDialogAction
  | DismissDialogAction;

/**
 * Accept a pending dialog, optionally answering a prompt.
 */
export interface AcceptDialogAction extends Action {
  type: 'acceptDialog';
  /** Text to submit when the dialog is a prompt. */
  promptText?: string;
}

/**
 * Dismiss a pending dialog.
 */
export interface DismissDialogAction extends Action {
  type: 'dismissDialog';
}

/**
 * The action set the stack DELIVERS today. Single source of truth: the
 * executor validates against this, engines advertise it in capabilities,
 * and SDK/MCP/OpenAPI derive their enums from it. `ActionType` above is
 * the protocol superset - extending DELIVERED_ACTION_TYPES is what turns
 * a protocol action into a delivered one.
 */
export const DELIVERED_ACTION_TYPES = [
  'click',
  'fill',
  'select',
  'scroll',
  'press',
  'acceptDialog',
  'dismissDialog',
] as const;

/**
 * The observation modes the stack delivers today (see
 * DELIVERED_ACTION_TYPES for the contract).
 */
export const DELIVERED_OBSERVATION_MODES = ['interactive', 'content', 'accessibility'] as const;

/**
 * Wait condition
 */
export interface WaitCondition {
  until: WaitType;
  timeoutMs?: number;
}

/**
 * Wait type
 */
export type WaitType =
  | 'domcontentloaded'
  | 'load'
  | 'networkidle'
  | 'selector'
  | 'url'
  | 'text'
  | 'function'
  | 'settled';

/**
 * Observation request
 */
export interface ObservationRequest {
  mode?: ObservationMode;
  maxBytes?: number;
  maxElements?: number;
  sinceRevision?: number;
  /** Resume a truncated observation from the cursor's nextOrdinal. */
  continueFrom?: number;
  scope?: 'viewport' | 'full' | 'frame' | 'element';
  include?: string[];
}

/**
 * Action response
 */
export interface ActionResult {
  actionId: string;
  startTimestamp: string;
  endTimestamp: string;
  oldRevision: number;
  newRevision: number;
  result: unknown;
  navigationStatus?: NavigationStatus;
  targetFingerprint?: string;
  policyDecision?: PolicyDecision;
  approvalDecision?: ApprovalDecision;
  observation?: PageState;
  artifacts?: ArtifactRef[];
  error?: import('./errors').ApiErrorDetail;
}

/**
 * Navigation status
 */
export interface NavigationStatus {
  status: 'success' | 'timeout' | 'blocked';
  url: string;
  redirectChain: string[];
}

/**
 * Policy decision
 */
export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  ruleMatched?: string;
}

/**
 * Approval decision
 */
export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  approvalRequired?: boolean;
}

/**
 * Artifact reference
 */
export interface ArtifactRef {
  artifactId: string;
  type: 'screenshot' | 'pdf' | 'trace' | 'download' | 'html' | 'dom';
  contentType: string;
  sizeBytes: number;
  url: string;
}
