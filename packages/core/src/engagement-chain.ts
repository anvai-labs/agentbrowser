import { createHash } from 'node:crypto';

/**
 * T10 M2: the engagement ledger's chain format, shared by the server-side
 * writer and the offline verifier (`agentbrowser engagement verify`).
 *
 * Each JSONL line is `{seq, at, type, data, prev, hash}` with
 * `hash = sha256(prev + "\n" + JSON.stringify({seq, at, type, data}))`;
 * the first `prev` is the genesis value.
 */
export const ENGAGEMENT_GENESIS = '0'.repeat(64);

export function engagementChainHash(prev: string, body: string): string {
  return createHash('sha256').update(`${prev}\n${body}`).digest('hex');
}

export type LedgerVerification =
  | { ok: true; records: number; closed: boolean }
  | { ok: false; seq: number; reason: string };

/**
 * Recomputes the chain and requires each line in canonical form. Detects edits, removals,
 * reorderings and appends that do not rewrite the chain; it cannot detect a full rewrite by
 * someone with write access (no key, no anchor). A truncated or crashed ledger verifies with
 * `closed: false`.
 */
export function verifyEngagementLedger(text: string): LedgerVerification {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let prev = ENGAGEMENT_GENESIS;
  let closed = false;
  for (const [index, line] of lines.entries()) {
    let record: {
      seq?: unknown;
      at?: unknown;
      type?: unknown;
      data?: unknown;
      prev?: unknown;
      hash?: unknown;
    };
    try {
      record = JSON.parse(line);
    } catch {
      return { ok: false, seq: index, reason: 'not JSON' };
    }
    if (closed) return { ok: false, seq: index, reason: 'record after engagement.closed' };
    if (record.seq !== index) return { ok: false, seq: index, reason: 'sequence break' };
    if (record.prev !== prev) return { ok: false, seq: index, reason: 'chain break' };
    if (index === 0 && record.type !== 'engagement.opened')
      return { ok: false, seq: 0, reason: 'missing engagement.opened' };
    const body = JSON.stringify({
      seq: record.seq,
      at: record.at,
      type: record.type,
      data: record.data,
    });
    if (record.hash !== engagementChainHash(prev, body))
      return { ok: false, seq: index, reason: 'hash mismatch' };
    // Canonical form only: no extra fields, duplicate keys or reformatting.
    const canonical = JSON.stringify({
      seq: record.seq,
      at: record.at,
      type: record.type,
      data: record.data,
      prev: record.prev,
      hash: record.hash,
    });
    if (line !== canonical) return { ok: false, seq: index, reason: 'not canonical' };
    prev = record.hash as string;
    if (record.type === 'engagement.closed') closed = true;
  }
  if (lines.length === 0) return { ok: false, seq: 0, reason: 'empty' };
  return { ok: true, records: lines.length, closed };
}
