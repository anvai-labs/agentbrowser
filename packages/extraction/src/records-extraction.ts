/**
 * Records extraction (TD-BROWSER-12)
 *
 * The repeating-structure counterpart to `schema`: one container CSS
 * selector matches each repeated block (a job card, a table row), and
 * per-field CSS selectors are evaluated inside each block to yield plain
 * JSON records. Pure function over the page DOM via linkedom — no model
 * calls, no network. Evidence is shared (same url/revision/hash) with a
 * per-record `index`, so every record is auditable against the page
 * revision it came from.
 */

import type { ExtractionResult, RawPageState } from '@agentbrowser/engine';
import { parseHTML } from 'linkedom';
import { fnv1aHash } from './hash.js';

export interface RecordsRequest {
  /** CSS selector matching each repeating record container. */
  container: string;
  /** CSS selector per field, evaluated within each record container. */
  fields: Record<string, string>;
  /** Optional cap on returned records (1–1000). */
  limit?: number;
}

const MAX_LIMIT = 1000;

/**
 * A caller-supplied records selector is not valid CSS for the DOM parser.
 * Typed so the service layer can map it to INVALID_REQUEST instead of
 * letting the parser's raw throw surface as a 500.
 */
export class RecordsSelectorError extends Error {
  constructor(
    message: string,
    readonly role: 'container' | 'field',
    readonly selector: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'RecordsSelectorError';
  }
}

function revisionOf(raw: RawPageState): number {
  const revision = (raw.metadata as { revision?: unknown } | undefined)?.revision;
  return typeof revision === 'number' ? revision : 0;
}

/** Collapse whitespace runs to single spaces with tidy trimming. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function extractRecords(raw: RawPageState, request: RecordsRequest): ExtractionResult {
  const limit =
    request.limit !== undefined && Number.isInteger(request.limit) && request.limit > 0
      ? Math.min(request.limit, MAX_LIMIT)
      : MAX_LIMIT;
  const { document } = parseHTML(raw.content);
  const shared = { url: raw.url, revision: revisionOf(raw), hash: fnv1aHash(raw.content) };

  const records: Array<Record<string, string>> = [];
  let containers: Iterable<{ querySelector(selector: string): { textContent: string } | null }>;
  try {
    containers = document.querySelectorAll(request.container);
  } catch (error) {
    throw new RecordsSelectorError(
      `Invalid CSS selector for records container: '${request.container.slice(0, 100)}'`,
      'container',
      request.container,
      { cause: error }
    );
  }
  for (const container of containers) {
    if (records.length >= limit) {
      break;
    }
    const record: Record<string, string> = {};
    for (const [field, selector] of Object.entries(request.fields)) {
      let match: { textContent: string } | null;
      try {
        match = container.querySelector(selector);
      } catch (error) {
        throw new RecordsSelectorError(
          `Invalid CSS selector for records field '${field}': '${selector.slice(0, 100)}'`,
          'field',
          selector,
          { cause: error }
        );
      }
      record[field] = collapse(match?.textContent ?? '');
    }
    records.push(record);
  }

  return {
    data: records,
    evidence: records.map((_, index) => ({ ...shared, index })),
    ...(records.length === 0 ? { evidence: [shared], warnings: ['no records found'] } : {}),
  };
}
