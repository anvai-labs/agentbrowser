import { EngineError } from '@agentbrowser/engine';
import type { PageState } from '@agentbrowser/protocol';

export interface ObservationBudget {
  maxElements?: number | undefined;
  maxBytes?: number | undefined;
  continueFrom?: number | undefined;
  /**
   * Page ordinals for each element of a PROJECTED list (compact projection).
   * Without it, ordinals are list indexes (today's arithmetic, reproduced
   * exactly by identity ordinals [0..n-1]). With it, continueFrom and the
   * continuation cursor address page ordinals, so a projected window can be
   * resumed without re-deriving which list positions matched.
   */
  ordinals?: readonly number[] | undefined;
}

const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Budget the final UTF-8 envelope, including truncation and cursor metadata.
 * Each removed item is serialized once, avoiding repeated whole-prefix scans.
 * Cursors address the complete normalized element list, not a pretrimmed prefix.
 */
export function budgetObservation(source: PageState, options: ObservationBudget = {}): PageState {
  for (const key of ['maxElements', 'maxBytes', 'continueFrom'] as const) {
    const value = options[key];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < (key === 'continueFrom' ? 0 : 1))
    )
      throw new EngineError(
        'INVALID_REQUEST',
        `Invalid ${key}: expected a ${key === 'continueFrom' ? 'non-negative' : 'positive'} safe integer.`
      );
  }
  if (options.ordinals !== undefined) {
    const ordinals = options.ordinals;
    if (ordinals.length !== source.elements.length)
      throw new EngineError('INVALID_REQUEST', 'ordinals must match the element count');
    for (let i = 0; i < ordinals.length; i += 1) {
      const ordinal = ordinals[i] ?? Number.NaN;
      const previous = i > 0 ? (ordinals[i - 1] ?? Number.NaN) : Number.NaN;
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || (i > 0 && ordinal <= previous)) {
        throw new EngineError(
          'INVALID_REQUEST',
          'ordinals must be non-negative strictly ascending integers'
        );
      }
    }
  }

  const ordinalAt = (index: number): number =>
    options.ordinals !== undefined ? (options.ordinals[index] ?? index) : index;

  const total = source.elements.length;
  // continueFrom is an ordinal floor: the window starts at the first element
  // whose ordinal reaches it (identity ordinals: the list index itself).
  let start = 0;
  const continueFrom = options.continueFrom;
  if (continueFrom !== undefined) {
    start = source.elements.findIndex((_, index) => ordinalAt(index) >= continueFrom);
    if (start === -1) {
      const lastOrdinal = total > 0 ? ordinalAt(total - 1) : -1;
      if (continueFrom > lastOrdinal + 1)
        throw new EngineError('INVALID_REQUEST', 'continueFrom exceeds the element count');
      start = total;
    }
  }
  const { continuation: _previousCursor, ...base } = source;
  let result: PageState = {
    ...base,
    elements: source.elements.slice(start, start + (options.maxElements ?? 300)),
    ...(source.text !== undefined ? { text: [...source.text] } : {}),
    ...(source.changes !== undefined ? { changes: [...source.changes] } : {}),
  };
  const updateCursor = () => {
    const nextOrdinal = ordinalAt(start + result.elements.length);
    if (result.elements.length < total - start) {
      result.continuation = { nextOrdinal, remaining: total - start - result.elements.length };
      result.truncated = true;
    }
  };
  updateCursor();
  const limit = options.maxBytes;
  if (limit === undefined || byteSize(result) <= limit) return result;
  result.truncated = true;
  let size = byteSize(result);
  // Prefer actionable elements over trailing diff/text detail. These arrays
  // have no continuation contract: callers need a larger budget for full detail.
  for (const items of [result.changes, result.text]) {
    while (items && items.length > 0 && size > limit) {
      const removed = items.pop();
      size -= byteSize(removed) + (items.length > 0 ? 1 : 0);
    }
  }
  while (result.elements.length > 1 && size > limit) {
    const oldCursor = result.continuation === undefined ? 0 : byteSize(result.continuation) + 16;
    const removed = result.elements.pop();
    size -= byteSize(removed) + 1;
    updateCursor();
    const newCursor = result.continuation === undefined ? 0 : byteSize(result.continuation) + 16;
    size += newCursor - oldCursor;
  }
  if (size > limit && result.summary !== undefined) {
    const { summary: _summary, ...minimal } = result;
    result = minimal;
    size = byteSize(result);
  }
  // Never return an oversized envelope or a non-advancing element cursor.
  // URL/title/revision are identity, not optional prose to silently mutilate.
  if (size > limit)
    throw new EngineError(
      'OUTPUT_TRUNCATED',
      'Observation budget cannot fit its identity and next element; increase maxBytes.',
      false,
      { maxBytes: limit, minBytes: size }
    );
  return result;
}
