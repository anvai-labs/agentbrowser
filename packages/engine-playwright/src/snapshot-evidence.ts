import { createHash } from 'node:crypto';
import { type Locator, errors } from 'playwright';

const DEFAULT_TIMEOUT_MS = 1000;
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
