// T10 P0-2 (ADR-030): end-to-end transport qualification of the fetch action
// through the real choke point — scope verdicts, nonce attribution, admission
// and the ledger. Receiver hits, not engine reports, establish wire behavior.
import { createServer, type Server } from 'node:http';
import type {
  EngineAction,
  EnginePage,
  EngineRequestRecord,
  EngineSession,
} from '@agentbrowser/engine';
import { EngagementScopePolicy, NetworkPolicy } from '@agentbrowser/policy';
import type { FetchResult } from '@agentbrowser/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

interface Hit {
  path: string;
  method: string;
  body: string;
  cookie: string | undefined;
  csrf: string | undefined;
  probeNonce: string | undefined;
  contentType: string | undefined;
}

const PUT_BODY = '{"price_cents":101}';
let hits: Hit[] = [];
let crossHits: Hit[] = [];
let server: Server;
let crossServer: Server;
let origin: string;
let crossOrigin: string;
let engine: PlaywrightChromiumEngine;
let records: EngineRequestRecord[] = [];

beforeAll(async () => {
  const handler =
    (cross: boolean) =>
    (
      request: import('node:http').IncomingMessage,
      response: import('node:http').ServerResponse
    ) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const path = request.url ?? '/';
        const headers = request.headers;
        const hit: Hit = {
          path,
          method: request.method ?? 'GET',
          body: Buffer.concat(chunks).toString(),
          cookie: headers.cookie,
          csrf: headers['x-csrf-token'] as string | undefined,
          probeNonce: headers['x-agentbrowser-probe'] as string | undefined,
          contentType: headers['content-type'],
        };
        if (cross) {
          crossHits.push(hit);
          response.writeHead(200);
          response.end('cross');
          return;
        }
        hits.push(hit);
        if (path === '/login') {
          response.writeHead(200, { 'set-cookie': 'sid=probe-session; Path=/' });
          response.end('<!doctype html><title>probe fixture</title>');
          return;
        }
        if (path === '/redirect-cross') {
          response.writeHead(302, { location: `${crossOrigin}/leak` });
          response.end();
          return;
        }
        if (path === '/redirect-cross-307') {
          response.writeHead(307, { location: `${crossOrigin}/leak307` });
          response.end();
          return;
        }
        if (path === '/redirect-same-307') {
          response.writeHead(307, { location: '/api/items/7' });
          response.end();
          return;
        }
        if (path === '/compete-driver') {
          // ADR-030's negative oracle: a page script that hammers the probe's
          // exact method+URL — after replacing fetch/Headers — must never be
          // attributed to the claim. The isolated world's transport does not
          // depend on the page world's fetch/Headers bindings.
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(
            '<!doctype html><title>compete</title><script>\n' +
              'const originalFetch = window.fetch.bind(window);\n' +
              'window.fetch = (...args) => originalFetch(...args);\n' +
              'window.Headers = class PatchedHeaders extends Headers {};\n' +
              'const hammer = () =>\n' +
              `  originalFetch('/compete', {\n` +
              `    method: 'PUT',\n` +
              `    headers: { 'content-type': 'text/plain;charset=UTF-8' },\n` +
              `    body: ${JSON.stringify(PUT_BODY)},\n` +
              '  }).catch(() => {});\n' +
              'window.__competing = (async () => {\n' +
              '  for (let i = 0; i < 60; i++) {\n' +
              '    void hammer();\n' +
              '    await new Promise((resolve) => setTimeout(resolve, 25));\n' +
              '  }\n' +
              '})();\n' +
              '</script>'
          );
          return;
        }
        if (path === '/compete') {
          // The page's own identical-PUT driver lands here too; distinguished
          // by the CSRF header only the probe carries.
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ got: headers['x-csrf-token'] ?? 'page' }));
          return;
        }
        if (path.startsWith('/api/')) {
          response.writeHead(200, {
            'content-type': 'application/json',
            'x-probe-evidence': 'exact',
          });
          response.end(JSON.stringify({ ok: true, method: request.method, path }));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>probe fixture</title>');
      });
    };
  server = createServer(handler(false));
  crossServer = createServer(handler(true));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => crossServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  crossOrigin = `http://127.0.0.1:${(crossServer.address() as { port: number }).port}`;
  engine = new PlaywrightChromiumEngine();
}, 60000);

afterAll(async () => {
  await engine?.close();
  for (const open of [server, crossServer]) {
    open?.closeAllConnections();
    if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
  }
});

interface Harness {
  session: EngineSession;
  page: EnginePage;
  scope: EngagementScopePolicy;
  records: EngineRequestRecord[];
  close(): Promise<void>;
}

async function harness(options: {
  allowedMethods?: string[];
  onScope?: (scope: EngagementScopePolicy) => void;
}): Promise<Harness> {
  hits = [];
  crossHits = [];
  records = [];
  const scope = new EngagementScopePolicy(new NetworkPolicy({ blockLoopback: false }), {
    allowedHosts: ['127.0.0.1'],
    ...(options.allowedMethods !== undefined ? { allowedMethods: options.allowedMethods } : {}),
  });
  options.onScope?.(scope);
  const session = await engine.createSession({
    requestRecorder: (record) => records.push(record),
    requestPolicy: scope,
  });
  const page = await session.newPage();
  await page.navigate({ url: `${origin}/login`, waitUntil: 'domcontentloaded' });
  return {
    session,
    page,
    scope,
    records,
    close: async () => {
      await session.close();
    },
  };
}

/** prepare + dispatch one probe the way the service adapter will. */
async function probe(
  page: EnginePage,
  request: {
    method: string;
    url: string;
    headers?: Array<{ name: string; value: string }>;
    body?: string;
  }
): Promise<{ result?: FetchResult; error?: { code: string; details?: Record<string, unknown> } }> {
  const action = { type: 'fetch', ...request } as unknown as EngineAction;
  const prepared = await page.prepareFetch!(action, { assertCurrent: () => {} });
  try {
    const effect = await page.act({
      ...action,
      fetchToken: prepared.token,
      fetchAssertCurrent: () => {},
      fetchBeforeDispatch: async () => {},
    } as unknown as EngineAction);
    return { result: effect.result as FetchResult };
  } catch (error) {
    const failure = error as { code?: string; details?: Record<string, unknown>; message?: string };
    return {
      error: {
        code: failure.code ?? 'UNKNOWN',
        details: {
          ...failure.details,
          ...(failure.message !== undefined ? { message: failure.message } : {}),
        },
      },
    };
  } finally {
    prepared.dispose();
  }
}

it('sends the authenticated PUT with exact bytes, cookie and CSRF header; nonce never reaches the wire', async () => {
  const h = await harness({ allowedMethods: ['GET', 'PUT'] });
  try {
    const { result, error } = await probe(h.page, {
      method: 'PUT',
      url: `${origin}/api/items/4029603257`,
      headers: [{ name: 'X-CSRF-Token', value: 'csrf-secret-1' }],
      body: PUT_BODY,
    });
    expect(error).toBeUndefined();
    expect(result?.status).toBe(200);
    expect(result?.truncated).toBe(false);
    const body = JSON.parse(result?.body ?? '{}');
    expect(body).toEqual({ ok: true, method: 'PUT', path: '/api/items/4029603257' });
    const hit = hits.find((entry) => entry.method === 'PUT');
    expect(hit).toBeDefined();
    expect(hit?.body).toBe(PUT_BODY);
    expect(hit?.cookie).toContain('sid=probe-session');
    expect(hit?.csrf).toBe('csrf-secret-1');
    expect(hit?.probeNonce).toBeUndefined();
    expect(hit?.contentType).toBe('text/plain;charset=UTF-8');
    // The ledger carries the probe outcome, marked as a probe.
    const row = h.records.find(
      (record) =>
        record.type === 'request.finished' && (record.data as { method?: string }).method === 'PUT'
    );
    expect(row).toBeDefined();
    expect(row?.data).toMatchObject({ probe: true });
  } finally {
    await h.close();
  }
}, 60000);

it('a scope without PUT denies the probe with SCOPE_METHOD_DENIED and zero receiver hits', async () => {
  const h = await harness({ allowedMethods: ['GET'] });
  try {
    const { error } = await probe(h.page, {
      method: 'PUT',
      url: `${origin}/api/items/1`,
      body: PUT_BODY,
    });
    expect(error?.code).toBe('POLICY_DENIED');
    expect(error?.details).toMatchObject({ scope: 'SCOPE_METHOD_DENIED' });
    expect(hits.filter((entry) => entry.method === 'PUT')).toHaveLength(0);
    const denied = h.records.find(
      (record) => (record.data as { scope?: string }).scope === 'SCOPE_METHOD_DENIED'
    );
    expect(denied).toBeDefined();
    expect(
      h.records.some(
        (record) =>
          (record.data as { scope?: string }).scope === 'SCOPE_METHOD_DENIED' &&
          (record.data as { probe?: boolean }).probe === true
      )
    ).toBe(true);
  } finally {
    await h.close();
  }
}, 60000);

it('attributes the probe exactly under competing identical-URL page traffic that replaced fetch/Headers', async () => {
  const h = await harness({ allowedMethods: ['GET', 'PUT'] });
  try {
    // The driver page replaces window.fetch and window.Headers, then hammers
    // the probe's exact method+URL for ~1.5s. Only the probe's request is
    // claimed and admitted; the page's identical copies — running while the
    // probe is in flight — flow through the ordinary paths unattributed.
    await h.page.navigate({ url: `${origin}/compete-driver`, waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const { result, error } = await probe(h.page, {
      method: 'PUT',
      url: `${origin}/compete`,
      headers: [{ name: 'X-CSRF-Token', value: 'probe-only' }],
      body: PUT_BODY,
    });
    expect(error).toBeUndefined();
    expect(JSON.parse(result?.body ?? '{}')).toEqual({ got: 'probe-only' });
    const competing = hits.filter((entry) => entry.path === '/compete');
    // The competition was real: page copies actually ran alongside the probe.
    expect(competing.filter((entry) => entry.csrf === undefined).length).toBeGreaterThanOrEqual(2);
    // Attribution is exact: no copy — page or probe — ever carried the nonce,
    // and exactly one hit is the probe's (its CSRF header).
    for (const hit of competing) expect(hit.probeNonce).toBeUndefined();
    expect(competing.filter((entry) => entry.csrf === 'probe-only')).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 60000);

it('refuses a cross-origin redirect destination (native lane) with zero cross-origin receiver hits', async () => {
  const h = await harness({ allowedMethods: ['GET', 'PUT'] });
  try {
    const { error } = await probe(h.page, {
      method: 'PUT',
      url: `${origin}/redirect-cross`,
      headers: [{ name: 'X-CSRF-Token', value: 'csrf-secret-1' }],
      body: PUT_BODY,
    });
    expect(error).toBeDefined();
    expect(error?.code).toBe('POLICY_DENIED');
    expect(error?.details).toMatchObject({ scope: 'SCOPE_HOST_DENIED' });
    expect(crossHits).toHaveLength(0);
  } finally {
    await h.close();
  }
}, 60000);

it('refuses a GET probe cross-origin redirect (inspected lane) without leaking the supplied header', async () => {
  const h = await harness({ allowedMethods: ['GET'] });
  try {
    const { error } = await probe(h.page, {
      method: 'GET',
      url: `${origin}/redirect-cross`,
      headers: [{ name: 'X-CSRF-Token', value: 'csrf-get' }],
    });
    expect(error).toBeDefined();
    expect(error?.code).toBe('POLICY_DENIED');
    expect(error?.details).toMatchObject({ scope: 'SCOPE_HOST_DENIED' });
    expect(crossHits).toHaveLength(0);
    expect(h.records.some((record) => (record.data as { probe?: boolean }).probe === true)).toBe(
      true
    );
  } finally {
    await h.close();
  }
}, 60000);

it('refuses a DELETE-with-body probe cross-origin 307 (inspected lane) with zero receiver hits', async () => {
  const h = await harness({ allowedMethods: ['GET', 'DELETE'] });
  try {
    const { error } = await probe(h.page, {
      method: 'DELETE',
      url: `${origin}/redirect-cross-307`,
      headers: [{ name: 'X-CSRF-Token', value: 'csrf-delete' }],
      body: PUT_BODY,
    });
    expect(error).toBeDefined();
    expect(error?.code).toBe('POLICY_DENIED');
    expect(error?.details).toMatchObject({ scope: 'SCOPE_HOST_DENIED' });
    // A 307 preserves method and body: nothing — request, header or body —
    // may reach the second origin (ADR-030 acceptance).
    expect(crossHits).toHaveLength(0);
  } finally {
    await h.close();
  }
}, 60000);

it('follows a same-origin 307 preserving method and body (native lane)', async () => {
  const h = await harness({ allowedMethods: ['GET', 'PUT'] });
  try {
    const { result, error } = await probe(h.page, {
      method: 'PUT',
      url: `${origin}/redirect-same-307`,
      headers: [{ name: 'X-CSRF-Token', value: 'csrf-2' }],
      body: PUT_BODY,
    });
    expect(error).toBeUndefined();
    const landed = hits.find((entry) => entry.path === '/api/items/7');
    expect(landed?.method).toBe('PUT');
    expect(landed?.body).toBe(PUT_BODY);
    expect(landed?.csrf).toBe('csrf-2');
    expect(JSON.parse(result?.body ?? '{}')).toEqual({
      ok: true,
      method: 'PUT',
      path: '/api/items/7',
    });
  } finally {
    await h.close();
  }
}, 60000);

it('follows a same-origin redirect on the inspected lane without ever shipping the nonce', async () => {
  const h = await harness({ allowedMethods: ['GET'] });
  try {
    const { result, error } = await probe(h.page, {
      method: 'GET',
      url: `${origin}/redirect-same-307`,
      headers: [{ name: 'X-CSRF-Token', value: 'csrf-get-hop' }],
    });
    expect(error).toBeUndefined();
    expect(result?.status).toBe(200);
    const landed = hits.find((entry) => entry.path === '/api/items/7');
    expect(landed?.method).toBe('GET');
    expect(landed?.csrf).toBe('csrf-get-hop');
    expect(landed?.probeNonce).toBeUndefined();
  } finally {
    await h.close();
  }
}, 60000);

it('serves a GET probe through the inspected lane with the exact body and no engine-injected headers', async () => {
  const h = await harness({ allowedMethods: ['GET'] });
  try {
    const { result, error } = await probe(h.page, { method: 'GET', url: `${origin}/api/items/9` });
    expect(error).toBeUndefined();
    expect(result?.status).toBe(200);
    expect(JSON.parse(result?.body ?? '{}')).toEqual({
      ok: true,
      method: 'GET',
      path: '/api/items/9',
    });
    const hit = hits.find((entry) => entry.path === '/api/items/9');
    expect(hit?.probeNonce).toBeUndefined();
    // Admitted headers are the server's evidence, not the choke point's own
    // document-policy injections (worker-src CSP and friends).
    const names = (result?.headers ?? []).map((header) => header.name.toLowerCase());
    expect(names).not.toContain('content-security-policy');
    expect(names).toContain('x-probe-evidence');
  } finally {
    await h.close();
  }
}, 60000);

it('refuses to prepare a probe on a session without an engagement scope (no lane, no mutation)', async () => {
  records = [];
  hits = [];
  const session = await engine.createSession({
    requestRecorder: (record) => records.push(record),
    requestPolicy: new NetworkPolicy({ blockLoopback: false }),
  });
  try {
    const page = await session.newPage();
    await page.navigate({ url: `${origin}/login`, waitUntil: 'domcontentloaded' });
    const action = {
      type: 'fetch',
      method: 'PUT',
      url: `${origin}/api/items/5`,
      body: PUT_BODY,
    } as unknown as EngineAction;
    await expect(page.prepareFetch!(action, { assertCurrent: () => {} })).rejects.toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
    });
    // Nothing was prepared, so nothing can dispatch: zero receiver hits.
    await expect(
      page.act({
        ...action,
        fetchToken: {},
        fetchAssertCurrent: () => {},
        fetchBeforeDispatch: async () => {},
      } as unknown as EngineAction)
    ).rejects.toThrow();
    expect(hits.filter((entry) => entry.method === 'PUT')).toHaveLength(0);
  } finally {
    await session.close();
  }
}, 60000);

it('refuses a probe on a page that navigated after preparation (no token replay)', async () => {
  const h = await harness({ allowedMethods: ['GET', 'PUT'] });
  try {
    const action = {
      type: 'fetch',
      method: 'PUT',
      url: `${origin}/api/items/2`,
      body: PUT_BODY,
    } as unknown as EngineAction;
    const prepared = await h.page.prepareFetch!(action, { assertCurrent: () => {} });
    await h.page.navigate({ url: `${origin}/login`, waitUntil: 'domcontentloaded' });
    await expect(
      h.page.act({
        ...action,
        fetchToken: prepared.token,
        fetchAssertCurrent: () => {},
        fetchBeforeDispatch: async () => {},
      } as unknown as EngineAction)
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(hits.filter((entry) => entry.path === '/api/items/2')).toHaveLength(0);
  } finally {
    await h.close();
  }
}, 60000);
