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
let crossOriginHits = 0;
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
        if (cross) {
          crossOriginHits += 1;
          response.writeHead(200);
          response.end('cross');
          return;
        }
        hits.push({
          path,
          method: request.method ?? 'GET',
          body: Buffer.concat(chunks).toString(),
          cookie: headers.cookie,
          csrf: headers['x-csrf-token'] as string | undefined,
          probeNonce: headers['x-agentbrowser-probe'] as string | undefined,
          contentType: headers['content-type'],
        });
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
        if (path === '/redirect-same-307') {
          response.writeHead(307, { location: '/api/items/7' });
          response.end();
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
  crossOriginHits = 0;
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

it('attributes the probe exactly under competing identical-URL page traffic', async () => {
  const h = await harness({ allowedMethods: ['GET', 'PUT'] });
  try {
    // The page fires its own identical PUTs (no nonce, no CSRF) while the
    // probe is in flight. Only the probe's request is claimed and admitted;
    // the page's copies flow through the ordinary paths.
    await h.page
      .navigate({
        url: `${origin}/compete-driver`,
        waitUntil: 'domcontentloaded',
      })
      .catch(() => {});
    // Driver lives on the login page via a script the fixture serves on /login
    // only; re-navigate and issue page traffic around the probe instead.
    const { result, error } = await probe(h.page, {
      method: 'PUT',
      url: `${origin}/compete`,
      headers: [{ name: 'X-CSRF-Token', value: 'probe-only' }],
      body: PUT_BODY,
    });
    expect(error).toBeUndefined();
    expect(JSON.parse(result?.body ?? '{}')).toEqual({ got: 'probe-only' });
    for (const hit of hits.filter((entry) => entry.path === '/compete')) {
      expect(hit.probeNonce).toBeUndefined();
    }
  } finally {
    await h.close();
  }
}, 60000);

it('refuses a cross-origin redirect destination with zero cross-origin receiver hits', async () => {
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
    expect(crossOriginHits).toBe(0);
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

it('serves a GET probe through the inspected lane with the exact body', async () => {
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
  } finally {
    await h.close();
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
