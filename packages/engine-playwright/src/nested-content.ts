import { positiveIntEnv } from './snapshot-evidence.js';

/**
 * TD-BROWSER-17 ask 2: honest degradation marker for nested-app surfaces.
 *
 * A top document can carry iframes whose functional pane is invisible to
 * top-document observation (portaled OOPIF panes rendering beside an empty
 * inline placeholder iframe; see the TD's Cloudflare Zero Trust repro). The
 * observation then reads as "nothing here" while a human sees a full pane —
 * an agent following it drives the wrong surface. This classifier decides
 * when `observe` must say so via `degradedReason: 'nested_content_unobservable'`
 * instead of reporting a quietly incomplete page.
 *
 * Conservative by design: benign hidden/analytics iframes must NOT trip the
 * marker, so every branch demands evidence that real content exists where
 * observation cannot fold it (branch 1), or that a large *visible* iframe
 * slot renders an empty placeholder while the top-level observation is
 * sparse (branch 2 — the TD repro signature).
 */

/** Best-effort probe of one child frame's document. */
export interface FrameContentProbe {
  /** Elements this frame contributed to the merged observation. */
  contributedElements: number;
  /**
   * body text length of the frame document; undefined means the probe could
   * not read the document (detached/uncommitted) — unknown, not empty.
   */
  bodyTextLength: number | undefined;
  /** Element-node count under the frame body; undefined means unknown. */
  domNodeCount: number | undefined;
  /**
   * Whether the frame's inline element renders visibly in the top document
   * (bounded size + computed style); undefined means unknown. Branch 1
   * requires known-visible: a hidden frame's body text (tag-manager and ad
   * frames routinely carry hundreds of characters) is exactly the benign
   * shape the marker must never report (adversarial review F1).
   */
  visible?: boolean;
}

export interface NestedContentUnobservableInput {
  /** Child frames present in the page (page.frames().length - 1). */
  childFrameCount: number;
  /** One probe per child frame that observation considered. */
  frames: FrameContentProbe[];
  /**
   * True when at least one inline `<iframe>` in the top document renders as
   * a large visible slot (see LARGE_IFRAME_SLOT_MIN_*). Hidden/zero-size
   * analytics frames never set this.
   */
  hasLargeVisibleIframeSlot: boolean;
  /**
   * Base elements observed in this observation (minted enrichment rows
   * excluded; frame contributions included). Zero means the top document
   * observed as empty — the SPA-not-mounted case, which keeps the
   * empty-snapshot-nonempty-dom diagnosis for BOTH branches (review F2):
   * "wait for mount" is the correct advice when nothing was observed at
   * all, and branch 2's displaced-pane claim needs a rendered shell.
   */
  topElementCount: number;
}

/**
 * Branch 2 gate: how sparse the top-level observation must read before a
 * large visible empty iframe slot is treated as "the content pane lives
 * elsewhere". The TD repro observes sidebar navigation only; ordinary
 * pages dwarf this. Overridable for exotic shells.
 */
const DEFAULT_MAX_TOP_ELEMENTS = 20;

/**
 * Branch 2 gate: a placeholder iframe document counts as empty below these
 * bounds — the TD repro's `<html><body></body></html>` is far under both.
 * Values above them mean the frame carries its own (unobserved) content,
 * which is branch 1's business.
 */
const PLACEHOLDER_MAX_TEXT = 50;
const PLACEHOLDER_MAX_NODES = 50;

/** An inline iframe slot counts as a "content pane" placeholder above these CSS px sizes. */
export const LARGE_IFRAME_SLOT_MIN_WIDTH = 200;
export const LARGE_IFRAME_SLOT_MIN_HEIGHT = 150;

/** The DOM surface the page function touches (the engine compiles without the DOM lib). */
interface IframeSlotDomNode {
  getBoundingClientRect(): { width: number; height: number };
  getAttribute(name: string): string | null;
  ownerDocument: {
    defaultView?: {
      getComputedStyle(node: unknown): { display?: string; visibility?: string };
    } | null;
  };
}

/**
 * Self-contained (serialized into the top document by evaluateAll): reports
 * every inline iframe's rendered slot size and visibility. A large visible
 * slot is where a content pane should render; hidden/zero-size frames are
 * the benign analytics shape and must never feed the marker.
 */
export function iframeSlotPageFunction(
  frames: IframeSlotDomNode[]
): Array<{ width: number; height: number; hidden: boolean }> {
  return Array.from(frames, (frame) => {
    const rect = frame.getBoundingClientRect();
    const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
    return {
      width: rect.width,
      height: rect.height,
      hidden:
        style?.display === 'none' ||
        style?.visibility === 'hidden' ||
        frame.getAttribute('aria-hidden') === 'true',
    };
  });
}

/**
 * The page function's output is untrusted page data (hostile-page
 * assumption): a slot counts only when every field validates and the slot
 * is visible and at least LARGE_IFRAME_SLOT_MIN_* CSS pixels.
 */
export function hasLargeVisibleIframeSlot(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((row) => {
    if (row === null || typeof row !== 'object') return false;
    const slot = row as Record<string, unknown>;
    return (
      typeof slot.width === 'number' &&
      Number.isFinite(slot.width) &&
      typeof slot.height === 'number' &&
      Number.isFinite(slot.height) &&
      slot.hidden === false &&
      slot.width >= LARGE_IFRAME_SLOT_MIN_WIDTH &&
      slot.height >= LARGE_IFRAME_SLOT_MIN_HEIGHT
    );
  });
}

/** The DOM surface the frame-element probe touches (no DOM lib). */
interface FrameElementDomNode {
  getBoundingClientRect(): { width: number; height: number };
  getAttribute(name: string): string | null;
  ownerDocument: {
    defaultView?: {
      getComputedStyle(node: unknown): { display?: string; visibility?: string };
    } | null;
  };
}

/**
 * Serialized into the frame's PARENT document (the frame element lives
 * there): whether the inline frame element renders with non-zero size, and
 * whether it declares a src. Hidden/zero-size frames (display:none
 * tag-manager mounts) carry hidden body text that must never read as
 * "content pane" evidence (adversarial review F1) — branch 1 requires
 * known-visible. A declared src while the frame still sits at about:blank
 * means a navigation is in flight (review F3): the provisional blank
 * document reports readyState 'complete' with an empty body — identical to
 * the repro placeholder to every document probe — so such frames read as
 * UNKNOWN (navigation pending), never as provably empty placeholders.
 */
export function frameElementProbePageFunction(node: FrameElementDomNode): {
  visible: boolean;
  src: string | null;
} {
  const rect = node.getBoundingClientRect();
  const style = node.ownerDocument.defaultView?.getComputedStyle(node);
  const visible =
    rect.width >= 1 &&
    rect.height >= 1 &&
    style?.display !== 'none' &&
    style?.visibility !== 'hidden';
  return { visible, src: node.getAttribute('src') };
}

/**
 * True when the page's nested content is present but unobservable and the
 * observation must say so rather than read as a complete (near-)empty page.
 *
 * - Branch 1: a child frame holds real content (text/elements above the
 *   same thresholds as `empty-snapshot-nonempty-dom`) yet contributed zero
 *   observed elements — observation cannot fold content that exists.
 * - Branch 2: every child frame is an empty placeholder, a large *visible*
 *   iframe slot renders where the pane should be, and the top-level
 *   observation is sparse (the TD repro: sidebar shell + empty inline
 *   iframe + pane portaled elsewhere).
 */
export function classifyNestedContentUnobservable(input: NestedContentUnobservableInput): boolean {
  if (input.childFrameCount < 1 || input.frames.length === 0) return false;
  // Both branches claim "content rendered somewhere observation did not
  // cover". A zero-element observation is the SPA-not-mounted case — the
  // correct advice is wait-and-re-observe, not the screenshot fallback
  // (review F2: the gate now covers branch 1 too, and the documented
  // precedence is enforced in code, not just in the TD).
  if (input.topElementCount < 1) return false;

  // Same "non-trivial content" bar as empty-snapshot-nonempty-dom — one
  // shared notion of "the DOM plainly holds content".
  const minText = positiveIntEnv('AGENTBROWSER_EMPTY_DOM_MIN_TEXT', 200);
  const minNodes = positiveIntEnv('AGENTBROWSER_EMPTY_DOM_MIN_NODES', 150);
  const foldable = (probe: FrameContentProbe): boolean =>
    probe.bodyTextLength !== undefined &&
    probe.domNodeCount !== undefined &&
    probe.visible === true;
  const unknown = (probe: FrameContentProbe): boolean =>
    probe.bodyTextLength === undefined || probe.domNodeCount === undefined;

  const unobservedWithContent = input.frames.some(
    (probe) =>
      probe.contributedElements === 0 &&
      foldable(probe) &&
      ((probe.bodyTextLength ?? 0) >= minText || (probe.domNodeCount ?? 0) >= minNodes)
  );
  if (unobservedWithContent) return true;

  // Unknown documents (probe failed) are neither content-rich nor provably
  // empty placeholders — never let them satisfy branch 2.
  const allEmptyPlaceholders =
    input.frames.length > 0 &&
    input.frames.every(
      (probe) =>
        probe.contributedElements === 0 &&
        !unknown(probe) &&
        (probe.bodyTextLength ?? 0) < PLACEHOLDER_MAX_TEXT &&
        (probe.domNodeCount ?? 0) < PLACEHOLDER_MAX_NODES
    );
  if (!allEmptyPlaceholders) return false;

  const maxTopElements = positiveIntEnv(
    'AGENTBROWSER_NESTED_UNOBSERVABLE_MAX_TOP_ELEMENTS',
    DEFAULT_MAX_TOP_ELEMENTS
  );
  // A zero-element top document is the SPA-not-mounted case
  // (empty-snapshot-nonempty-dom); branch 2 claims a *rendered shell with a
  // displaced pane*, which needs at least the shell to have been observed.
  return (
    input.hasLargeVisibleIframeSlot &&
    input.topElementCount >= 1 &&
    input.topElementCount <= maxTopElements
  );
}
