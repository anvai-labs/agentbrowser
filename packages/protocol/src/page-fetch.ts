import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * ADR-030: the `fetch` action's single source of truth for method, header and
 * body bounds. The schema carries the structural constraints; the semantic
 * refusals (forbidden header names, duplicates, GET/HEAD bodies, aggregate
 * byte bounds) live in `fetchProbeIssues` so surfaces, the service and the
 * engine all enforce the same list — a bound that exists only in one layer is
 * a bound the next layer silently drops.
 */

/** Methods a browser fetch can issue and this product admits. CONNECT/TRACE/TRACK refuse. */
export const PROBE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export type ProbeMethod = (typeof PROBE_METHODS)[number];
const METHOD_SET = new Set<string>(PROBE_METHODS);

/**
 * Header names a caller may never supply: browser-controlled transport
 * headers, and credential headers whose explicit supply would bypass the
 * cookie jar's credential-review floors (ADR-030: deliberate product limit —
 * the page origin's cookies apply; CSRF-style custom headers are the intended
 * auth surface). Case-insensitive.
 */
export const FORBIDDEN_PROBE_HEADERS = [
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'proxy-authorization',
  'proxy-connection',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'x-agentbrowser-probe',
] as const;
const FORBIDDEN = new Set<string>(FORBIDDEN_PROBE_HEADERS);

export const MAX_PROBE_HEADERS = 16;
/** Aggregate supplied header bytes: names + values + separators. */
export const MAX_PROBE_HEADER_BYTES = 8192;
/** Request body bound, measured in UTF-8 bytes. */
export const MAX_PROBE_BODY_BYTES = 65536;
/** Response body bound in the public result, measured in UTF-8 bytes. */
export const MAX_PROBE_RESPONSE_BODY_BYTES = 1024 * 1024;
export const MAX_PROBE_RESPONSE_HEADERS = 32;
/** Aggregate response header bytes in the public result. */
export const MAX_PROBE_RESPONSE_HEADER_BYTES = 8192;

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** One supplied request header; order-preserving pairs, never a map. */
export const ProbeHeaderSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
    value: Type.String({ minLength: 0, maxLength: MAX_PROBE_HEADER_BYTES }),
  },
  { additionalProperties: false }
);
export type ProbeHeader = Static<typeof ProbeHeaderSchema>;

/** Methods that may carry a request body under Fetch semantics. */
export const PROBE_BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const BODY_METHOD_SET = new Set<string>(PROBE_BODY_METHODS);

/**
 * The fetch action: discriminated by method so a GET/HEAD body is refused by
 * the schema union itself (one gate for wire, service and engine callers),
 * not only by the semantic check below.
 */
export const FetchActionSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('fetch'),
      method: Type.Union(
        PROBE_METHODS.filter((m) => !BODY_METHOD_SET.has(m)).map((literal) => Type.Literal(literal))
      ),
      /** Absolute http(s) URL, no userinfo, no fragment; same-origin enforced at the engine. */
      url: Type.String({ minLength: 8, maxLength: 2048 }),
      headers: Type.Optional(
        Type.Array(ProbeHeaderSchema, { minItems: 1, maxItems: MAX_PROBE_HEADERS })
      ),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal('fetch'),
      /** Uppercase; the engine canonicalizes and refuses unknown methods. */
      method: Type.Union(PROBE_BODY_METHODS.map((literal) => Type.Literal(literal))),
      url: Type.String({ minLength: 8, maxLength: 2048 }),
      headers: Type.Optional(
        Type.Array(ProbeHeaderSchema, { minItems: 1, maxItems: MAX_PROBE_HEADERS })
      ),
      /** UTF-8 body. */
      body: Type.Optional(Type.String({ maxLength: MAX_PROBE_BODY_BYTES })),
    },
    { additionalProperties: false }
  ),
]);

/**
 * The bounded public response of a fetch action. `bodyBytes` is the measured
 * decoded size before any truncation, so a caller can tell a small body from a
 * truncated large one; `truncated` covers any body or header reduction.
 */
export const FetchResultSchema = Type.Object(
  {
    status: Type.Integer({ minimum: 100, maximum: 599 }),
    headers: Type.Array(ProbeHeaderSchema),
    body: Type.String(),
    /** Decoded response bytes before truncation. */
    bodyBytes: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
    /** Terminal response kind after native redirect following (ADR-030 naming). */
    outcome: Type.Union([
      Type.Literal('terminal'),
      Type.Literal('bodyless'),
      Type.Literal('redirect'),
    ]),
  },
  { additionalProperties: false }
);
export type FetchResult = Static<typeof FetchResultSchema>;

export interface FetchProbeIssue {
  path: string;
  message: string;
}

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

/**
 * Semantic refusals the type schema cannot express: forbidden and duplicate
 * header names, aggregate header bytes, GET/HEAD bodies, UTF-8 body bytes
 * beyond the bound (JS string length under-counts astral characters), and the
 * URL shape (absolute http(s), no userinfo, no fragment). Strictly additive:
 * every issue is a refusal, never a repair.
 */
export function fetchProbeIssues(input: {
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  body?: unknown;
}): FetchProbeIssue[] {
  const issues: FetchProbeIssue[] = [];
  const method = typeof input.method === 'string' ? input.method.toUpperCase() : input.method;
  if (typeof method !== 'string' || !METHOD_SET.has(method)) {
    issues.push({
      path: '/method',
      message: `Method must be one of ${PROBE_METHODS.join(', ')}; got ${String(input.method)}`,
    });
  }
  if (typeof input.url === 'string') {
    let parsed: URL | undefined;
    try {
      parsed = new URL(input.url);
    } catch {
      issues.push({ path: '/url', message: 'URL must be absolute and parseable' });
    }
    if (parsed !== undefined) {
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        issues.push({ path: '/url', message: 'URL must be http(s)' });
      }
      if (parsed.username || parsed.password) {
        issues.push({ path: '/url', message: 'URL cannot carry userinfo' });
      }
      if (parsed.hash) {
        issues.push({ path: '/url', message: 'URL cannot carry a fragment' });
      }
    }
  } else if (input.url !== undefined) {
    issues.push({ path: '/url', message: 'URL must be a string' });
  }
  if (input.headers !== undefined) {
    if (!Array.isArray(input.headers)) {
      issues.push({ path: '/headers', message: 'Headers must be an array of {name, value} pairs' });
    } else {
      if (input.headers.length > MAX_PROBE_HEADERS) {
        issues.push({
          path: '/headers',
          message: `At most ${MAX_PROBE_HEADERS} headers; got ${input.headers.length}`,
        });
      }
      const seen = new Set<string>();
      let bytes = 0;
      for (const [index, header] of input.headers.entries()) {
        const at = `/headers/${index}`;
        if (typeof header !== 'object' || header === null) {
          issues.push({ path: at, message: 'Header must be an object' });
          continue;
        }
        const record = header as Record<string, unknown>;
        if (Object.keys(record).some((key) => key !== 'name' && key !== 'value')) {
          issues.push({ path: at, message: 'Header carries unknown fields' });
        }
        if (typeof record.name !== 'string' || typeof record.value !== 'string') {
          issues.push({ path: at, message: 'Header name and value must be strings' });
          continue;
        }
        const name = record.name;
        if (!HEADER_NAME_PATTERN.test(name)) {
          issues.push({ path: `${at}/name`, message: 'Header name must be an RFC 7230 token' });
          continue;
        }
        const lower = name.toLowerCase();
        if (FORBIDDEN.has(lower)) {
          issues.push({
            path: `${at}/name`,
            message: `Header '${name}' is browser-controlled or credential-carrying and cannot be supplied`,
          });
          continue;
        }
        if (seen.has(lower)) {
          issues.push({ path: `${at}/name`, message: `Duplicate header '${name}'` });
          continue;
        }
        seen.add(lower);
        bytes += byteLength(name) + byteLength(record.value) + 4;
        if (bytes > MAX_PROBE_HEADER_BYTES) {
          issues.push({
            path: '/headers',
            message: `Aggregate header bytes exceed ${MAX_PROBE_HEADER_BYTES}`,
          });
          break;
        }
      }
    }
  }
  if (input.body !== undefined) {
    if (typeof input.body !== 'string') {
      issues.push({ path: '/body', message: 'Body must be a UTF-8 string' });
    } else {
      if (typeof method === 'string' && METHOD_SET.has(method) && !BODY_METHOD_SET.has(method)) {
        issues.push({ path: '/body', message: `Method ${method} cannot carry a body` });
      }
      if (byteLength(input.body) > MAX_PROBE_BODY_BYTES) {
        issues.push({
          path: '/body',
          message: `Body exceeds ${MAX_PROBE_BODY_BYTES} UTF-8 bytes`,
        });
      }
    }
  }
  return issues;
}

/** The canonical, validated fetch action (nested protocol shape). */
export type ValidatedFetchAction = {
  type: 'fetch';
  method: ProbeMethod;
  url: string;
  headers?: ProbeHeader[];
  body?: string;
};

/** Structural + semantic validation of a constructed fetch action. */
export function parseFetchAction(
  input: unknown
): { ok: true; value: ValidatedFetchAction } | { ok: false; issues: FetchProbeIssue[] } {
  if (!Value.Check(FetchActionSchema, input)) {
    const issues: FetchProbeIssue[] = [];
    for (const error of Value.Errors(FetchActionSchema, input)) {
      issues.push({ path: error.path, message: error.message });
    }
    return { ok: false, issues };
  }
  const action = input as ValidatedFetchAction;
  const issues = fetchProbeIssues(action);
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: { ...action, method: action.method.toUpperCase() as ProbeMethod } };
}

/**
 * Reduce a measured response to the bounded public result. Truncation is
 * disclosed, never silent: `truncated` is set for any body or header cut, and
 * `bodyBytes` keeps the pre-truncation measure so 1 MiB of body cannot pass
 * as a complete large response.
 */
export function boundFetchResult(measured: {
  status: number;
  outcome: FetchResult['outcome'];
  headers: Array<{ name: string; value: string }>;
  body: string;
  bodyBytes: number;
}): FetchResult {
  let headerBytes = 0;
  const headers: ProbeHeader[] = [];
  let truncated = false;
  for (const header of measured.headers) {
    if (headers.length >= MAX_PROBE_RESPONSE_HEADERS) {
      truncated = true;
      break;
    }
    const bytes = byteLength(header.name) + byteLength(header.value) + 4;
    if (headerBytes + bytes > MAX_PROBE_RESPONSE_HEADER_BYTES) {
      truncated = true;
      break;
    }
    headerBytes += bytes;
    headers.push({ name: header.name, value: header.value });
  }
  let body = measured.body;
  if (byteLength(body) > MAX_PROBE_RESPONSE_BODY_BYTES) {
    // Cut on a codepoint boundary: a mid-sequence byte cut would decode to
    // U+FFFD and silently corrupt the last character of the evidence. Walk
    // back from the cut to the sequence's lead byte and drop the sequence
    // entirely unless it is complete within the cut.
    const buffer = Buffer.from(body, 'utf8').subarray(0, MAX_PROBE_RESPONSE_BODY_BYTES);
    let end = buffer.length;
    if (end > 0) {
      let start = end - 1;
      let byte = buffer[start] ?? 0;
      while (start > 0 && (byte & 0xc0) === 0x80) {
        start -= 1;
        byte = buffer[start] ?? 0;
      }
      const leadByte = byte;
      const expected = leadByte < 0x80 ? 1 : leadByte >= 0xf0 ? 4 : leadByte >= 0xe0 ? 3 : 2;
      if (end - start !== expected) end = start;
    }
    body = buffer.subarray(0, end).toString('utf8');
    truncated = true;
  }
  return {
    status: measured.status,
    outcome: measured.outcome,
    headers,
    body,
    bodyBytes: measured.bodyBytes,
    truncated,
  };
}
