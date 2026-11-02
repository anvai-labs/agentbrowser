import { EngineError, type RequestPolicy } from '@agentbrowser/engine';
import type { CDPSession } from 'playwright';
import { PageOperationLifetime } from './page-operation-lifetime.js';
import { scopedResponseBody } from './scoped-response-body.js';

const MAX_HEADER_ROWS = 256;
const MAX_HEADER_BYTES = 65536;
const MAX_DECODED_BYTES = 8 * 1024 * 1024;
const MAX_READ_MS = 15000;

type Header = { name: string; value: string };

/** Private transport result; never substitute this for the bounded public DTO. */
export type AdmittedPageFetchResponse =
  | { kind: 'terminal'; headers: Header[]; body: Buffer }
  | { kind: 'bodyless'; headers: Header[]; body: undefined }
  | { kind: 'redirect'; headers: Header[]; body: undefined };

function snapshotHeaders(input: readonly Header[]): {
  raw: Header[];
  policy: Record<string, string>;
} {
  const refuse = () => {
    throw new EngineError('POLICY_DENIED', 'Fetch response headers cannot be admitted', false);
  };
  if (input.length > MAX_HEADER_ROWS) refuse();
  const raw: Header[] = [];
  const policy: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const row of input) {
    if (row.name.length + row.value.length > MAX_HEADER_BYTES) refuse();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(row.name)) refuse();
    for (let i = 0; i < row.value.length; i++) {
      const code = row.value.charCodeAt(i);
      if ((code < 32 && code !== 9) || code === 127) refuse();
    }
    bytes += Buffer.byteLength(row.name) + Buffer.byteLength(row.value) + 4;
    if (bytes > MAX_HEADER_BYTES) refuse();
    const name = row.name.toLowerCase();
    if (name === 'location' && policy[name] !== undefined) refuse();
    if (
      name === 'content-length' &&
      (policy[name] !== undefined ||
        !/^\d+$/.test(row.value.trim()) ||
        !Number.isSafeInteger(Number(row.value.trim())))
    )
      refuse();
    raw.push({ name: row.name, value: row.value });
    policy[name] = policy[name] === undefined ? row.value : `${policy[name]}, ${row.value}`;
  }
  return { raw, policy };
}

/**
 * T10 P0-2 transport admission. Call only with the actual paused CDP response.
 * Every failure must fail/cancel that response, including a late stream handle:
 * after taking the body, continuing the original response is not a safe fallback.
 */
export async function admitPageFetchResponse(
  cdp: Pick<CDPSession, 'send'>,
  response: {
    requestId: string;
    method: string;
    status: number;
    headers: readonly Header[];
  },
  policy: Pick<RequestPolicy, 'checkResponse' | 'checkBodySize'>,
  owner: {
    signal: AbortSignal;
    assertCurrent: () => void;
    timeoutMs?: number;
    maxBytes?: number;
  }
): Promise<AdmittedPageFetchResponse> {
  const { requestId, method, status } = response;
  const { signal, assertCurrent, timeoutMs = MAX_READ_MS, maxBytes = MAX_DECODED_BYTES } = owner;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > MAX_READ_MS ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > MAX_DECODED_BYTES ||
    !Number.isInteger(status) ||
    status < 200 ||
    status > 599
  )
    throw new EngineError('INVALID_REQUEST', 'Invalid fetch response admission bound', false);
  const lifetime = new PageOperationLifetime(signal, assertCurrent, timeoutMs, 'Fetch');
  const checkResponse = policy.checkResponse?.bind(policy);
  const checkBodySize = policy.checkBodySize?.bind(policy);
  const guard = () => lifetime.assert('fetch_response', true);
  try {
    guard();
    // Snapshot once, before the first policy await. Keep delivery headers distinct
    // from the normalized record (in particular duplicate Set-Cookie fields).
    const headers = snapshotHeaders(response.headers);
    const redirect =
      [301, 302, 303, 307, 308].includes(status) &&
      headers.raw.some(({ name }) => name.toLowerCase() === 'location');
    if (checkResponse)
      await lifetime.read(
        'fetch_response_headers',
        () => checkResponse({ headers: headers.policy }),
        undefined,
        true
      );
    guard();
    if (redirect) {
      // Chromium cannot stream a redirect body's bytes here. Fetch discards
      // them; the caller must still admit the destination before continuing.
      // Do not report a fictitious zero-byte witness for this response.
      return { kind: 'redirect', headers: headers.raw, body: undefined };
    }
    if (method.toUpperCase() === 'HEAD' || [204, 205, 304].includes(status)) {
      if (checkBodySize)
        await lifetime.read('fetch_response_bytes', () => checkBodySize(0), undefined, true);
      guard();
      return { kind: 'bodyless', headers: headers.raw, body: undefined };
    }
    const body = await lifetime.read(
      'fetch_response_body',
      () =>
        scopedResponseBody(cdp, requestId, {
          maxBytes,
          timeoutMs: Math.max(0, lifetime.deadline - performance.now()),
          signal,
          assertCurrent: guard,
          ...(checkBodySize ? { checkBytes: checkBodySize } : {}),
        }),
      (late) => late.fill(0),
      true
    );
    return { kind: 'terminal', headers: headers.raw, body };
  } finally {
    lifetime.finish();
  }
}
