import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  boundFetchResult,
  FetchActionSchema,
  fetchProbeIssues,
  MAX_PROBE_BODY_BYTES,
  MAX_PROBE_RESPONSE_BODY_BYTES,
  MAX_PROBE_RESPONSE_HEADERS,
  PROBE_METHODS,
  parseFetchAction,
} from './page-fetch.js';
import { validateAction } from './validators.js';

const valid = {
  type: 'fetch',
  method: 'PUT',
  url: 'https://vinted.com/api/items/4029603257',
  headers: [{ name: 'X-CSRF-Token', value: 'abc123' }],
  body: '{"price_cents":101}',
};

describe('FetchActionSchema', () => {
  it('accepts a well-formed probe and refuses unknown methods and fields', () => {
    expect(Value.Check(FetchActionSchema, valid)).toBe(true);
    expect(Value.Check(FetchActionSchema, { ...valid, method: 'TRACE' })).toBe(false);
    expect(Value.Check(FetchActionSchema, { ...valid, extra: 1 })).toBe(false);
    expect(Value.Check(FetchActionSchema, { ...valid, target: { ref: 'e1_0' } })).toBe(false);
  });

  it('flows through the delivered action validator', () => {
    const result = validateAction(valid);
    expect(result.ok).toBe(true);
    expect(validateAction({ ...valid, method: 'GET', body: 'x' }).ok).toBe(false);
  });
});

describe('fetchProbeIssues', () => {
  it('reports no issues for a valid probe', () => {
    expect(fetchProbeIssues(valid)).toEqual([]);
  });

  it('refuses non-http(s), userinfo and fragment URLs', () => {
    expect(fetchProbeIssues({ ...valid, url: 'ftp://vinted.com/x' }).map((i) => i.path)).toEqual([
      '/url',
    ]);
    expect(
      fetchProbeIssues({ ...valid, url: 'https://u:p@vinted.com/x' }).map((i) => i.path)
    ).toEqual(['/url']);
    expect(
      fetchProbeIssues({ ...valid, url: 'https://vinted.com/x#frag' }).map((i) => i.path)
    ).toEqual(['/url']);
    expect(fetchProbeIssues({ ...valid, url: 'not a url' }).map((i) => i.path)).toEqual(['/url']);
  });

  it('refuses forbidden, malformed and duplicate headers', () => {
    expect(
      fetchProbeIssues({ ...valid, headers: [{ name: 'Cookie', value: 'sid=1' }] }).map(
        (i) => i.path
      )
    ).toEqual(['/headers/0/name']);
    expect(
      fetchProbeIssues({ ...valid, headers: [{ name: 'Authorization', value: 'Bearer x' }] }).map(
        (i) => i.path
      )
    ).toEqual(['/headers/0/name']);
    expect(
      fetchProbeIssues({ ...valid, headers: [{ name: 'X-AgentBrowser-Probe', value: 'x' }] }).map(
        (i) => i.path
      )
    ).toEqual(['/headers/0/name']);
    expect(
      fetchProbeIssues({ ...valid, headers: [{ name: 'bad name', value: 'x' }] }).map((i) => i.path)
    ).toEqual(['/headers/0/name']);
    expect(
      fetchProbeIssues({
        ...valid,
        headers: [
          { name: 'X-CSRF-Token', value: 'a' },
          { name: 'x-csrf-token', value: 'b' },
        ],
      }).map((i) => i.path)
    ).toEqual(['/headers/1/name']);
  });

  it('refuses method-tunneling, context-spoofing and fetch-spec prefix header families', () => {
    // A 'read'-classified GET must not carry an effective write method past
    // the method-based approval floor (mirror of scope-request-headers).
    for (const name of [
      'X-HTTP-Method-Override',
      'X-HTTP-Method',
      'X-Method-Override',
      'X-Method',
      'X-Override-Method',
      'X-REST-Method',
      'X-Forwarded-For',
      'X-Forwarded-Host',
      'X-Original-Method',
      'X-Rewrite-URL',
      'X-Real-IP',
      'Sec-Fetch-Site',
      'Proxy-Connection',
    ]) {
      expect(
        fetchProbeIssues({ ...valid, headers: [{ name, value: 'DELETE' }] }).map((i) => i.path),
        name
      ).toEqual(['/headers/0/name']);
    }
    // The refusal is case-insensitive and never repairs.
    expect(
      fetchProbeIssues({
        ...valid,
        headers: [{ name: 'x-http-method-override', value: 'd' }],
      }).map((i) => i.path)
    ).toEqual(['/headers/0/name']);
  });

  it('refuses the synthetic-denial marker header a caller could self-denial with', () => {
    expect(
      fetchProbeIssues({
        ...valid,
        headers: [{ name: 'X-AgentBrowser-Blocked', value: '1' }],
      }).map((i) => i.path)
    ).toEqual(['/headers/0/name']);
  });

  it('still accepts the intended auth surface: CSRF-style custom headers', () => {
    expect(
      fetchProbeIssues({
        ...valid,
        headers: [
          { name: 'X-CSRF-Token', value: 'csrf-secret-0123456789' },
          { name: 'X-Auth-Token', value: 'ok' },
          { name: 'X-Custom-Trace', value: 'id-1' },
        ],
      })
    ).toEqual([]);
  });

  it('refuses header values carrying CR, LF, NUL or non-Latin-1 codepoints', () => {
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const NUL = String.fromCharCode(0);
    expect(
      fetchProbeIssues({ ...valid, headers: [{ name: 'X-Safe', value: `a${CR}${LF}b` }] }).map(
        (i) => i.path
      )
    ).toEqual(['/headers/0/value']);
    expect(
      fetchProbeIssues({ ...valid, headers: [{ name: 'X-Safe', value: `a${LF}b` }] }).map(
        (i) => i.path
      )
    ).toEqual(['/headers/0/value']);
    expect(
      fetchProbeIssues({ ...valid, headers: [{ name: 'X-Safe', value: `a${NUL}b` }] }).map(
        (i) => i.path
      )
    ).toEqual(['/headers/0/value']);
    // A codepoint above U+00FF throws in the browser's Headers (ByteString);
    // refuse it with a typed message instead of an opaque engine error.
    expect(
      fetchProbeIssues({
        ...valid,
        headers: [{ name: 'X-Safe', value: `token-${String.fromCharCode(0x2713)}` }],
      }).map((i) => i.path)
    ).toEqual(['/headers/0/value']);
    // The Latin-1 supplement stays ByteString-encodable.
    expect(fetchProbeIssues({ ...valid, headers: [{ name: 'X-Safe', value: 'café' }] })).toEqual(
      []
    );
  });

  it('bounds aggregate header bytes', () => {
    const issues = fetchProbeIssues({
      ...valid,
      headers: Array.from({ length: 8 }, (_, i) => ({ name: `X-H-${i}`, value: 'x'.repeat(1100) })),
    });
    expect(issues.some((i) => i.message.includes('Aggregate header bytes'))).toBe(true);
  });

  it('refuses bodies on GET/HEAD and bodies beyond the UTF-8 byte bound', () => {
    expect(fetchProbeIssues({ ...valid, method: 'GET', body: '{}' }).map((i) => i.path)).toEqual([
      '/body',
    ]);
    expect(fetchProbeIssues({ ...valid, method: 'HEAD', body: '{}' }).map((i) => i.path)).toEqual([
      '/body',
    ]);
    // Astral characters: JS length 32770 < bound but 65540 UTF-8 bytes > bound.
    const astral = '𝕊'.repeat(MAX_PROBE_BODY_BYTES / 4 + 1);
    expect(astral.length).toBeLessThan(MAX_PROBE_BODY_BYTES);
    const issues = fetchProbeIssues({ ...valid, body: astral });
    expect(issues.map((i) => i.path)).toEqual(['/body']);
  });

  it('accepts bodies on the body-bearing methods only', () => {
    for (const method of PROBE_METHODS) {
      const issues = fetchProbeIssues({ ...valid, method, body: '{}' });
      const bodyIssue = issues.some((i) => i.path === '/body');
      // OPTIONS is safe/idempotent like GET/HEAD: no body semantics.
      expect(bodyIssue).toBe(method === 'GET' || method === 'HEAD' || method === 'OPTIONS');
    }
  });
});

describe('parseFetchAction', () => {
  it('is strict about the method literal: lowercase refuses, never repairs', () => {
    const parsed = parseFetchAction({ ...valid, method: 'put' });
    expect(parsed.ok).toBe(false);
  });

  it('refuses a probe with any issue', () => {
    expect(parseFetchAction({ ...valid, method: 'GET', body: 'x' }).ok).toBe(false);
  });
});

describe('boundFetchResult', () => {
  it('passes a small response through unchanged', () => {
    const bounded = boundFetchResult({
      status: 200,
      outcome: 'terminal',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      body: '{"ok":true}',
      bodyBytes: 10,
    });
    expect(bounded).toEqual({
      status: 200,
      outcome: 'terminal',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      body: '{"ok":true}',
      bodyBytes: 10,
      truncated: false,
    });
  });

  it('truncates an oversized body on a UTF-8 boundary and keeps the true measure', () => {
    const body = 'x'.repeat(MAX_PROBE_RESPONSE_BODY_BYTES + 10);
    const bounded = boundFetchResult({
      status: 200,
      outcome: 'terminal',
      headers: [],
      body,
      bodyBytes: MAX_PROBE_RESPONSE_BODY_BYTES + 10,
    });
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.body, 'utf8')).toBe(MAX_PROBE_RESPONSE_BODY_BYTES);
    expect(bounded.bodyBytes).toBe(MAX_PROBE_RESPONSE_BODY_BYTES + 10);
  });

  it('drops headers past the row and byte bounds with disclosure', () => {
    const rows = Array.from({ length: MAX_PROBE_RESPONSE_HEADERS + 5 }, (_, i) => ({
      name: `X-H-${i}`,
      value: 'v',
    }));
    const bounded = boundFetchResult({
      status: 204,
      outcome: 'bodyless',
      headers: rows,
      body: '',
      bodyBytes: 0,
    });
    expect(bounded.headers).toHaveLength(MAX_PROBE_RESPONSE_HEADERS);
    expect(bounded.truncated).toBe(true);

    const wide = Array.from({ length: 4 }, (_, i) => ({
      name: `X-H-${i}`,
      value: 'x'.repeat(4000),
    }));
    expect(
      boundFetchResult({ status: 200, outcome: 'terminal', headers: wide, body: '', bodyBytes: 0 })
        .truncated
    ).toBe(true);
  });

  it('never splits a codepoint when truncating', () => {
    // 3-byte codepoints: the 1 MiB byte cut lands mid-sequence.
    const body = '✓'.repeat(400000);
    const bounded = boundFetchResult({
      status: 200,
      outcome: 'terminal',
      headers: [],
      body,
      bodyBytes: Buffer.byteLength(body, 'utf8'),
    });
    expect(bounded.truncated).toBe(true);
    expect(bounded.body.endsWith('�')).toBe(false);
    expect(bounded.body.endsWith('✓')).toBe(true);
    expect(bounded.bodyBytes).toBe(1200000);
  });
});
