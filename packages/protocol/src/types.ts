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
  controlMode?: 'delegated';
  /** Engine selection; omitted = server default. */
  engine?: EngineSelection;
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
  /**
   * Per-session override (1-30000ms, default 5000) for the whole-page
   * ariaSnapshot budget observe() uses before degrading to a DOM-tag-only
   * fallback (no name/value, no custom-widget roles). Raise it for a
   * session known to navigate large/complex forms. Not a SessionPolicy
   * field: it is a reliability/performance knob, not an egress/security
   * trade-off.
   */
  snapshotTimeoutMs?: number;
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
 * Engine selection. The two literals are the protocol-known names; the
 * registry (TD-BROWSER-7) also routes arbitrary registered engine names
 * (e.g. 'safari'), so the request field accepts any string while keeping
 * autocomplete for the known ones. Unknown names fail loudly at the
 * service (ENGINE_NOT_FOUND).
 */
export type EngineType = 'playwright-chromium' | 'auto';

/** Request-facing engine selection: known names or a registered name. */
export type EngineSelection = EngineType | (string & {});

/**
 * Session policy configuration
 */
export interface SessionPolicy {
  /** Optional since Phase 3: blockedHosts-only / downloads-only policies are legitimate (restrict-only). */
  allowedHosts?: string[];
  blockedHosts?: string[];
  allowDownloads?: boolean;
  maxDownloadBytes?: number;
  approval?: ApprovalPolicy;
  /**
   * ADR-019: off by default. Service workers bypass this session's egress
   * choke point (Playwright cannot route service-worker-originated
   * requests - microsoft/playwright#1090), so it is disabled whenever a
   * policy is in effect. Set true to explicitly accept that trade-off for
   * one session, e.g. a destination whose anti-fraud tooling keys off
   * service-worker presence and rejects sessions that block it.
   */
  allowServiceWorkers?: boolean;
}

/**
 * Approval policy for actions
 */
export interface ApprovalPolicy {
  review?: 'operator';
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
  | 'dblclick'
  | 'hover'
  | 'fill'
  | 'type'
  | 'typeText'
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
  /** Present only when requested via include:["overlays"]. */
  overlays?: OverlayBlocker[];
  truncated: boolean;
  untrustedContent: boolean;
  /**
   * Cursor for fetching the rest of a truncated observation, in stable
   * document order. Present only when truncated.
   */
  continuation?: ContinuationCursor;
  /**
   * dom-semantic-subset means an adapter supplies a limited DOM interpretation,
   * not native AX. Increasing snapshotTimeoutMs cannot restore missing support.
   *
   * True when the whole-page ariaSnapshot budget was exceeded and `elements`
   * came from a DOM-tag-only fallback: roles are bare HTML tags with no
   * name/value, and any custom widget with no native form control (e.g. a
   * div-based combobox) is entirely absent. Do not trust role/name matching
   * on this observation - retry with a larger snapshotTimeoutMs on the
   * session, or narrow the observation instead.
   */
  degraded?: boolean;
  /** Why the observation has reduced semantic coverage. */
  degradedReason?: 'aria-snapshot-timeout' | 'dom-semantic-subset';
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
  /** Link destination, captured at observation time on role:"link" elements. */
  href?: string;
  /** True when the captured href exceeded the 2048-char capture limit. */
  hrefTruncated?: boolean;
  /**
   * Engine-captured attributes; populated for role:"fileinput" elements
   * requested via observe include:["fileInputs"] (carries id, accept, and
   * multiple so callers can tell ambiguous file inputs apart).
   */
  attributes?: Record<string, string>;
  /**
   * Checked state for checkbox/radio/switch roles: true or false from the
   * engine's authoritative read; absent when it cannot be determined
   * (tri-state mixed, or degraded observations without bound handles).
   */
  checked?: boolean | undefined;
}

/**
 * An element that intercepts pointer events over observed targets, aggregated
 * across the examined elements (F5).
 */
export interface OverlayBlocker {
  tag: string;
  role?: string;
  name?: string;
  /** Number of examined elements this blocker was found over. */
  covers: number;
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
 * ADR-015: the engine package's result interface used to carry this same
 * name with a completely different shape. The risk classification keeps
 * the union; engines (and anything else that needs the classification
 * name) use this alias so a module importing both cannot collide.
 */
export type ActionEffectType = ActionEffect;

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
  'records',
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
  /**
   * Compare a native input/textarea value after one fill. A mismatch fails
   * with VALUE_MISMATCH without refilling or echoing either value. Success
   * returns verified:true; it proves the comparison at readback time, not
   * a durable application commit. Unqualified engines refuse this option.
   */
  expectValue?: string;
}

/**
 * TypeText action: real per-character keystrokes (focus, then one keydown /
 * textInput / keyup sequence per character), unlike fill which sets the value
 * and fires a single input event. For widgets that only react to genuine key
 * events: search-as-you-type boxes, keystroke-driven masks, typeahead filters.
 * Unqualified engines refuse this action instead of degrading to a fill.
 */
export interface TypeTextAction extends Action {
  type: 'typeText';
  target?: ElementTarget;
  value: string;
  /**
   * Delay in ms between characters (0-1000, default 0). A small delay helps
   * debounced typeahead filters that drop characters arriving too fast.
   */
  delay?: number;
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
 * Upload action: attach local file(s) to an <input type=file>. Hidden file
 * inputs (the Dropzone-style common case) get refs from observe only when the
 * request includes the "fileInputs" token; without a target the engine
 * requires exactly one file input on the page. Playwright setInputFiles
 * semantics: the given paths REPLACE the input's file list.
 */
export interface UploadAction extends Action {
  type: 'upload';
  target?: ElementTarget;
  paths: string[];
  /** Single-file, bounded integrity check; the engine uploads the bytes it hashes. */
  sha256?: string;
  /** Metadata only, requires sha256; default application/octet-stream. */
  mimeType?: string;
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
  /**
   * Press the key this many times in one action (1-20, default 1). One
   * revision bump covers the whole run - spinbutton-style controls need
   * repeated keypresses and a re-observe between every single press makes
   * them impractical.
   */
  count?: number;
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
  | DblClickAction
  | HoverAction
  | FillAction
  | TypeTextAction
  | ClearAction
  | CheckAction
  | UncheckAction
  | SelectAction
  | UploadAction
  | ScrollAction
  | PressAction
  | WaitAction
  | GoBackAction
  | GoForwardAction
  | ReloadAction
  | AcceptDialogAction
  | DismissDialogAction;

/**
 * Hover an element (non-mutating).
 */
export interface HoverAction extends Action {
  type: 'hover';
  target: ElementTarget;
}

/**
 * Double-click an element.
 */
export interface DblClickAction extends Action {
  type: 'dblclick';
  target: ElementTarget;
}

/**
 * Clear an input's value.
 */
export interface ClearAction extends Action {
  type: 'clear';
  target: ElementTarget;
}

/**
 * Tick a checkbox or radio.
 */
export interface CheckAction extends Action {
  type: 'check';
  target: ElementTarget;
}

/**
 * Untick a checkbox.
 */
export interface UncheckAction extends Action {
  type: 'uncheck';
  target: ElementTarget;
}

/**
 * Navigate back in history.
 */
export interface GoBackAction extends Action {
  type: 'goBack';
}

/**
 * Navigate forward in history.
 */
export interface GoForwardAction extends Action {
  type: 'goForward';
}

/**
 * Reload the current page.
 */
export interface ReloadAction extends Action {
  type: 'reload';
}

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
  'dblclick',
  'hover',
  'fill',
  'typeText',
  'clear',
  'check',
  'uncheck',
  'select',
  'upload',
  'scroll',
  'press',
  'wait',
  'goBack',
  'goForward',
  'reload',
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

export const DELIVERED_WAIT_TYPES = [
  'settled',
  'domcontentloaded',
  'load',
  'networkidle',
  'urlPattern',
  'selectorVisible',
  'minElements',
] as const;
export type DeliveredWaitCondition = {
  until: (typeof DELIVERED_WAIT_TYPES)[number];
  timeoutMs?: number;
  /** urlPattern only: glob (wildcards) or a slash-delimited regex. */
  pattern?: string;
  /** selectorVisible only: CSS selector polled for visibility. */
  selector?: string;
  /** minElements only: minimum observed element count. */
  count?: number;
};

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
  | 'settled'
  | 'urlPattern'
  | 'selectorVisible'
  | 'minElements';

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
  /** Present only when the engine healed a replaced target (F2, opt-in). */
  remap?: { from: string; to: string };
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
