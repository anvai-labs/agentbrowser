import { createHash } from 'node:crypto';
import { type Locator, errors } from 'playwright';

// Was 1000ms; too small for real multi-section forms (200+ elements, custom
// React-Select-style comboboxes) where a whole-body ariaSnapshot legitimately
// takes longer, silently degrading observe() to the DOM-tag-only fallback
// (see getContentElements() in index.ts) with no signal to the caller.
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30_000;

function validTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
}

export function snapshotTimeout(explicit: number | undefined): number {
  if (explicit !== undefined) {
    if (!validTimeout(explicit)) {
      throw new RangeError('snapshotTimeoutMs must be an integer between 1 and 30000');
    }
    return explicit;
  }
  const raw = process.env.AGENTBROWSER_SNAPSHOT_TIMEOUT_MS?.trim() ?? '';
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return validTimeout(parsed) ? parsed : DEFAULT_TIMEOUT_MS;
}

/** Bound snapshot waiting, not the other DOM work in an observation. */
export class SnapshotBudget {
  private readonly deadline: number;

  constructor(timeoutMs: number) {
    this.deadline = performance.now() + timeoutMs;
  }

  async capture(locator: Locator): Promise<string | undefined> {
    const remaining = this.deadline - performance.now();
    // Playwright interprets zero as unlimited, not expired.
    if (remaining <= 0) return undefined;
    try {
      return await locator.ariaSnapshot({ timeout: Math.ceil(remaining) });
    } catch (error) {
      if (error instanceof errors.TimeoutError) return undefined;
      throw error;
    }
  }
}

export function snapshotDigest(value: string | undefined): string | undefined {
  return value === undefined ? undefined : createHash('sha256').update(value).digest('hex');
}

// An ariaSnapshot can succeed quickly yet yield no addressable elements while
// the live DOM is full of content - the common failure mode for a JS SPA whose
// React/Vue tree has mounted role-less markup that the accessibility tree does
// not surface. That is NOT a timeout, so it never trips SnapshotBudget; without
// this classifier observe() would report `elements: []` indistinguishably from a
// genuinely empty page. When true, callers get degradedReason
// 'empty-snapshot-nonempty-dom' - a signal to wait/retry or fall back to HTML.
const DEFAULT_EMPTY_DOM_MIN_TEXT = 200;
const DEFAULT_EMPTY_DOM_MIN_NODES = 150;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim() ?? '';
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface EmptyObservationInput {
  /** Elements the accessibility tree actually surfaced. */
  elementCount: number;
  /** Length of document.body.innerText at observation time. */
  bodyTextLength: number;
  /** Count of element nodes under document.body at observation time. */
  domNodeCount: number;
}

/**
 * True when the accessibility snapshot surfaced nothing but the DOM plainly
 * holds content - i.e. an empty-but-successful snapshot over a non-empty DOM.
 * Thresholds are overridable via AGENTBROWSER_EMPTY_DOM_MIN_TEXT /
 * AGENTBROWSER_EMPTY_DOM_MIN_NODES.
 */
export function classifyEmptyObservation(input: EmptyObservationInput): boolean {
  if (input.elementCount > 0) return false;
  const minText = positiveIntEnv('AGENTBROWSER_EMPTY_DOM_MIN_TEXT', DEFAULT_EMPTY_DOM_MIN_TEXT);
  const minNodes = positiveIntEnv('AGENTBROWSER_EMPTY_DOM_MIN_NODES', DEFAULT_EMPTY_DOM_MIN_NODES);
  return input.bodyTextLength >= minText || input.domNodeCount >= minNodes;
}

export interface SnapshotEvidence {
  /** Undefined means unavailable, not an empty or unchanged snapshot. */
  snapshot: string | undefined;
  /** Shared fixed-size whole-document evidence for timed-out element captures. */
  documentSnapshot: string | undefined;
}

export function sameSnapshotEvidence(
  previous: SnapshotEvidence,
  current: SnapshotEvidence
): boolean {
  if (previous.snapshot !== undefined && current.snapshot !== undefined) {
    return previous.snapshot === current.snapshot;
  }
  // Also covers element/document transitions without silently refreshing old refs.
  return (
    previous.documentSnapshot !== undefined &&
    current.documentSnapshot !== undefined &&
    previous.documentSnapshot === current.documentSnapshot
  );
}
