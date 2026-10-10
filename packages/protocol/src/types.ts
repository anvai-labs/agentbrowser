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
  /**
   * Optional readiness wait applied BEFORE the capture, so a JS SPA that has
   * not painted yet does not yield a blank image. Reuses the same wait
   * mechanism as browser_act.
   */
  wait?: DeliveredWaitCondition;
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
  /** Select a trusted, startup-configured operator profile attachment. */
  cdpAttach?: boolean;
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
/**
 * T7 slice 2a: one path rule of an engagement scope. A host with no
 * binding rule is fully in scope for paths; prefixes match on
 * path-segment boundaries (prefix "/api" admits "/api" and "/api/users",
 * never "/apix").
 */
export interface ScopePathRule {
  /** Exact host or ".suffix" (subdomains only). Absent = every allowed host. */
  hostSuffix?: string;
  prefix: string;
}

/** One identity binding: the marker must not leave its bound hosts. */
export interface ScopeIdentityBinding {
  header: string;
  value: string;
  allowedHosts: string[];
}

/**
 * T7 slice 2a: engagement scope for authorized security testing
 * (hosts/paths/methods/identities/time/budget), enforced per request and
 * per redirect hop by EngagementScopePolicy as the outermost
 * restrict-only layer of the session's policy chain.
 */
export interface EngagementScope {
  /** Exhaustive when set: exact hosts and ".suffix" entries in scope. */
  allowedHosts: string[];
  pathRules?: ScopePathRule[];
  allowedMethods?: string[];
  /** Epoch ms; the scope is expired at or after this instant. */
  expiresAt?: number;
  /** Total choke-point requests in scope, redirect hops included. */
  requestBudget?: number;
  identityBindings?: ScopeIdentityBinding[];
}

/**
 * C4b: the execution requirement for application writes. Missing
 * normalizes to 'ephemeral'; 'durable' requires a qualified durable
 * journal store and refuses typed when the runtime cannot satisfy it.
 */
export type ExecutionRequirement = 'ephemeral' | 'durable';

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
  /** T7 slice 2a: engagement scope enforced on top of the whole chain. */
  scope?: EngagementScope;
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
  /** Diagnostics reported by the browser host. */
  warnings?: string[];
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
  supportsCdpAttach?: boolean;
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
/** One child frame the observation could not fully inspect (T6). */
export interface FrameCoverage {
  frame: string;
  status: 'timeout' | 'unavailable' | 'depth_exceeded' | 'budget_exceeded' | 'loading';
  reason?: string;
}

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
  /** Child frames not fully inspected, present only when some are missing. */
  frameCoverage?: FrameCoverage[];
  /**
   * Cursor for fetching the rest of a truncated observation, in stable
   * document order. Present only when truncated.
   */
  continuation?: ContinuationCursor;
  /**
   * Present only when a compact projection was applied: echoes the filters
   * and the matched/total counts so a subset can never read as the whole
   * page. See ObservationProjectionEcho.
   */
  projection?: ObservationProjectionEcho;
  /**
   * dom-semantic-subset means an adapter supplies a limited DOM interpretation,
   * not native AX. Increasing snapshotTimeoutMs cannot restore missing support.
   *
   * aria-snapshot-timeout means elements came from a DOM fallback with
   * best-effort roles and names. Its semantic coverage is reduced; a larger
   * snapshotTimeoutMs may recover the accessibility tree.
   *
   * 'empty-snapshot-nonempty-dom' is a distinct case: the ariaSnapshot
   * SUCCEEDED (no timeout) but surfaced no addressable elements while the live
   * DOM plainly holds content - the common JS-SPA-not-mounted-yet failure. Wait
   * for readiness (observe/screenshot `wait`) and retry, or read via
   * browser_html.
   */
  degraded?: boolean;
  /** Why the observation has reduced semantic coverage. */
  degradedReason?: 'aria-snapshot-timeout' | 'dom-semantic-subset' | 'empty-snapshot-nonempty-dom';
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
  /**
   * True when this element's value, if any, is withheld: classified sensitive
   * (password/hidden input, credential autocomplete semantics, or an explicit
   * sensitive fill), or its type could not be established at the DOM-binding
   * boundary and the value failed closed. Absent value + valueRedacted:true
   * means "withheld", not "empty".
   */
  valueRedacted?: boolean;
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
  /**
   * 0-based nesting depth within the element's snapshot block (the flattened
   * a11y tree in document order). Absent means 0 (top level of the block).
   * Present only when the engine records it; enables scope-by-ref projection.
   */
  depth?: number;
  /**
   * Snapshot block identity: absent/0 = main frame; each merged child-frame
   * block increments. Depth is block-local, so a scope slice must stop at a
   * block boundary (frame content is appended at the list end, not at the
   * iframe's document position).
   */
  block?: number;
  /**
   * True when a compact projection capped this element's name at 200 chars
   * (mirrors hrefTruncated). Only ever set in projected output; the stored
   * element keeps the full name.
   */
  nameTruncated?: boolean;
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
type DeliveredWaitOptions = {
  timeoutMs?: number;
  pattern?: string;
  selector?: string;
  count?: number;
};
export type DeliveredWaitCondition = DeliveredWaitOptions &
  (
    | {
        until: Exclude<
          (typeof DELIVERED_WAIT_TYPES)[number],
          'urlPattern' | 'selectorVisible' | 'minElements'
        >;
      }
    | { until: 'urlPattern'; pattern: string }
    | { until: 'selectorVisible'; selector: string }
    | { until: 'minElements'; count: number }
  );

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
export const DELIVERED_OBSERVATION_INCLUDES = ['overlays', 'fileInputs', 'formControls'] as const;

/** Additive element-field opt-ins for compact projection (protected core excluded). */
export const DELIVERED_PROJECTION_FIELDS = ['href', 'attributes', 'required'] as const;

export interface ObservationRequest {
  mode?: (typeof DELIVERED_OBSERVATION_MODES)[number];
  maxBytes?: number;
  maxElements?: number;
  sinceRevision?: number;
  /** Resume a truncated observation from the cursor's nextOrdinal. */
  continueFrom?: number;
  include?: (typeof DELIVERED_OBSERVATION_INCLUDES)[number][];
  /**
   * Optional readiness wait applied BEFORE the snapshot, so a slow-mounting JS
   * SPA does not observe as empty. Reuses the same wait mechanism as
   * browser_act (settled/networkidle/selectorVisible/minElements/...).
   */
  wait?: DeliveredWaitCondition;
  /**
   * Compact projection (opt-in): keep only elements with these exact roles.
   * Response carries a `projection` echo; without any projection field the
   * observation is the unchanged full shape.
   */
  roles?: string[];
  /**
   * Compact projection: case-insensitive substring match against element
   * NAMES only (never values — matching withheld values would leak a
   * redaction side channel). Max 200 chars.
   */
  name?: string;
  /**
   * Compact projection: scope to this element's subtree — the scope element
   * plus following elements in the same snapshot block with greater depth.
   * Must resolve at the current revision, else STALE_TARGET (ADR-004
   * symmetry); a removed element fails TARGET_NOT_FOUND, never an empty 200.
   */
  scopeRef?: string;
  /** Compact projection: cap on the filtered element count (1-500). */
  limit?: number;
  /**
   * Compact projection: additive opt-in element fields. The protected core
   * (ref, role, name, value, valueRedacted, checked, risk, focused,
   * non-default visible/enabled, depth/block) is never droppable.
   */
  includeFields?: (typeof DELIVERED_PROJECTION_FIELDS)[number][];
}

/**
 * Echo of the applied compact projection. `matched` is the element count the
 * predicate kept; `total` is the pre-projection count (under sinceRevision,
 * the changed set). A 0-match result on a large page means "no matching
 * elements", never "empty page".
 */
export interface ObservationProjectionEcho {
  roles?: string[];
  name?: string;
  scopeRef?: string;
  matched: number;
  total: number;
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
  reason?: import('./navigation-failure.js').NavigationFailureReason;
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
  url?: string;
  inline?: { contentBase64: string; byteSize: number };
  createdAt?: number;
  expiresAt?: number;
  filename?: string;
  sessionId?: string;
  tenantId?: string;
  warnings?: string[];
}
