import { EngineError } from '@agentbrowser/engine';
import type { PageState } from '@agentbrowser/protocol';

export interface ObservationBudget {
  maxElements?: number | undefined;
  maxBytes?: number | undefined;
  continueFrom?: number | undefined;
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
  const start = options.continueFrom ?? 0;
  const total = source.elements.length;
  if (start > total)
    throw new EngineError('INVALID_REQUEST', 'continueFrom exceeds the element count');
  const { continuation: _previousCursor, ...base } = source;
  let result: PageState = {
    ...base,
    elements: source.elements.slice(start, start + (options.maxElements ?? 300)),
    ...(source.text !== undefined ? { text: [...source.text] } : {}),
    ...(source.changes !== undefined ? { changes: [...source.changes] } : {}),
  };
  const updateCursor = () => {
    const nextOrdinal = start + result.elements.length;
    if (nextOrdinal < total) {
      result.continuation = { nextOrdinal, remaining: total - nextOrdinal };
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
