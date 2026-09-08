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

export interface RecordsRequest {
  /** CSS selector matching each repeating record container. */
  container: string;
  /** CSS selector per field, evaluated within each record container. */
  fields: Record<string, string>;
  /** Optional cap on returned records (1–1000). */
  limit?: number;
}

const MAX_LIMIT = 1000;

/** FNV-1a, identical to the other deterministic extractors' evidence hash. */
function hash(content: string): string {
  let digest = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    digest ^= content.charCodeAt(i);
    digest = Math.imul(digest, 0x01000193) >>> 0;
  }
  return digest.toString(16).padStart(8, '0');
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
  const shared = { url: raw.url, revision: revisionOf(raw), hash: hash(raw.content) };

  const records: Array<Record<string, string>> = [];
  for (const container of document.querySelectorAll(request.container)) {
    if (records.length >= limit) {
      break;
    }
    const record: Record<string, string> = {};
    for (const [field, selector] of Object.entries(request.fields)) {
      record[field] = collapse(container.querySelector(selector)?.textContent ?? '');
    }
    records.push(record);
  }

  return {
    data: records,
    evidence: records.map((_, index) => ({ ...shared, index })),
    ...(records.length === 0 ? { evidence: [shared], warnings: ['no records found'] } : {}),
  };
}
