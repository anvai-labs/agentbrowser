// T10 P0-2 prerequisite: receiver bytes and sealed ledgers qualify the existing
// UI transport before a custom API-probe action can use it. Local fixtures only.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyEngagementLedger } from '@agentbrowser/core';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';

const payload = `exact-request-π-\u0000-${'x'.repeat(8192)}`;
const sha256 = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
type Hit = {
  host: string;
  method: string;
  path: string;
  sha256: string;
  bytes: number;
  contentType?: string;
  authorization?: string;
  cookie?: string;
};

async function fixture(
  options: {
    unscoped?: boolean;
    baseDenyOther?: boolean;
    maxResponseSize?: number;
    authenticated?: boolean;
  } = {}
) {
  const hits: Hit[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'http://fixture');
    hits.push({
      host: (req.headers.host ?? '').split(':')[0]!,
      method: req.method!,
      path: url.pathname,
      sha256: sha256(body),
      bytes: body.length,
      contentType: req.headers['content-type'],
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    });
    if (url.pathname === '/run') {
      const method = url.searchParams.get('method')!;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<link rel=icon href="data:,"><title>pending</title><script>
        fetch(${JSON.stringify(url.searchParams.get('target'))}, {
          method:${JSON.stringify(method)},
          ${method === 'GET' || method === 'HEAD' ? '' : `body:${JSON.stringify(payload)},`}
          ${options.authenticated ? `headers:{authorization:'Bearer fixture-authorization'},credentials:'include',` : ''}
          cache:'no-store'
        }).then(async r=>{const body=await r.text();document.title=body.includes('cap-response-sentinel')?'settled:leaked':'settled:done'},()=>{document.title='settled:error'});
        </script>`);
      return;
    }
    if (url.pathname === '/large') {
      const oversized = 'cap-response-sentinel'.repeat(4096);
      if (url.searchParams.get('length') === '1')
        res.setHeader('content-length', Buffer.byteLength(oversized));
      else res.write('');
      res.end(oversized);
      return;
    }
    if (url.pathname.startsWith('/hop/')) {
      const status = Number(url.pathname.split('/')[2]);
      const next = url.searchParams.get('next') ?? '/landed';
      const location = url.searchParams.has('out')
        ? `http://localhost:${(server.address() as { port: number }).port}${next}`
        : next;
      res.writeHead(status, { location });
      res.end();
      return;
    }
    res.end('terminal');
  });
  await new Promise<void>((ok, bad) => {
    server.once('error', bad);
    server.listen(0, '127.0.0.1', ok);
  });
  const directory = await mkdtemp(join(tmpdir(), 'redirect-methods-'));
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({
      blockLoopback: options.baseDenyOther === true,
      ...(options.baseDenyOther
        ? {
            exceptions: {
              allowLoopback: ({ target }) => target === '127.0.0.1',
              allowPrivate: () => false,
            },
          }
        : {}),
      ...(options.maxResponseSize ? { maxResponseSize: options.maxResponseSize } : {}),
    }),
    engagement: { directory },
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    hits,
    service,
    origin,
    async run(method: string, target: string, restriction?: 'method' | 'host' | 'budget' | 'rate') {
      const session = await service.createSession({
        tenantId: 'redirect-owner',
        ...(options.authenticated
          ? {
              cookies: [
                { name: 'sid', value: 'fixture-owner-cookie', domain: '127.0.0.1', path: '/' },
                { name: 'sid', value: 'fixture-other-cookie', domain: 'localhost', path: '/' },
              ],
            }
          : {}),
        ...(options.unscoped
          ? {}
          : {
              scope: {
                allowedHosts: options.authenticated ? ['127.0.0.1', 'localhost'] : ['127.0.0.1'],
                allowedMethods: restriction === 'method' ? ['GET'] : ['GET', 'HEAD', method],
                requestBudget: restriction === 'budget' ? 2 : 100,
                ...(restriction === 'rate' ? { rateLimit: { requests: 2, perSeconds: 60 } } : {}),
                ledger: true,
              },
            }),
      });
      const { sessionId } = session;
      const { pageId } = await service.createPage(sessionId);
      await service.navigate(sessionId, pageId, {
        url: `${origin}/run?${new URLSearchParams({ method, target })}`,
      });
      let title: string | undefined;
      await expect
        .poll(
          async () => {
            title = (await service.observe(sessionId, pageId, {})).title;
            return title;
          },
          { timeout: 10000 }
        )
        .toMatch(/^settled:/);
      const denials = options.unscoped ? {} : service.getScopeStatus(sessionId).denials;
      await service.closeSession(sessionId);
      if (!session.engagementId) return { denials, ledger: '', title };
      const exported = await service.engagementLedgerFile('redirect-owner', session.engagementId!);
      const ledger = await readFile(exported.path, 'utf8');
      expect(verifyEngagementLedger(ledger)).toMatchObject({ ok: true, closed: true });
      expect(ledger).not.toContain('exact-request-');
      expect(ledger).not.toContain('fixture-authorization');
      expect(ledger).not.toContain('fixture-owner-cookie');
      expect(ledger).not.toContain('fixture-other-cookie');
      return { denials, ledger, title };
    },
    async close() {
      await service.shutdown();
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it.each([
  ['HEAD', 301],
  ['HEAD', 302],
  ['HEAD', 303],
  ['HEAD', 307],
  ['HEAD', 308],
  ['DELETE', 301],
  ['DELETE', 302],
  ['DELETE', 307],
  ['DELETE', 308],
  ['OPTIONS', 302],
  ['OPTIONS', 307],
  ['PROPFIND', 307],
] as const)(
  'preserves %s method and exact body through a same-origin %i then 307',
  async (method, status) => {
    const f = await fixture();
    try {
      const next = '/hop/307?next=/landed';
      const { denials, ledger } = await f.run(
        method,
        `/hop/${status}?${new URLSearchParams({ next })}`
      );
      expect(denials).toEqual({});
      const writes = f.hits.filter((hit) => hit.path !== '/run');
      expect(writes).toHaveLength(3);
      for (const hit of writes)
        expect(hit).toMatchObject({
          host: '127.0.0.1',
          method,
          bytes: method === 'HEAD' ? 0 : Buffer.byteLength(payload),
          sha256: sha256(method === 'HEAD' ? '' : payload),
        });
      expect(ledger).toContain(`"method":"${method}"`);
    } finally {
      await f.close();
    }
  },
  30000
);

it.each(['POST', 'PUT', 'DELETE'])(
  'keeps %s converted to GET after 303 through a subsequent 307',
  async (method) => {
    const f = await fixture();
    try {
      await f.run(method, `/hop/303?next=${encodeURIComponent('/hop/307?next=/landed')}`);
      expect(f.hits.filter((hit) => hit.path !== '/run')).toEqual([
        expect.objectContaining({ path: '/hop/303', method, sha256: sha256(payload) }),
        expect.objectContaining({ path: '/hop/307', method: 'GET', bytes: 0 }),
        expect.objectContaining({ path: '/landed', method: 'GET', bytes: 0 }),
      ]);
      expect(
        f.hits
          .filter((hit) => hit.method === 'GET' && hit.path !== '/run')
          .map((hit) => hit.contentType)
      ).toEqual([undefined, undefined]);
    } finally {
      await f.close();
    }
  },
  30000
);

it.each(['DELETE', 'OPTIONS', 'PROPFIND'])(
  'preserves the unscoped base-policy redirect floor for %s',
  async (method) => {
    const f = await fixture({ unscoped: true, baseDenyOther: true });
    try {
      await f.run(method, '/hop/307?out=1&next=/landed');
      expect(f.hits.some((hit) => hit.path === '/hop/307' && hit.method === method)).toBe(true);
      expect(f.hits.some((hit) => hit.path === '/landed')).toBe(false);
      expect(f.hits.some((hit) => hit.host === 'localhost')).toBe(false);
    } finally {
      await f.close();
    }
  },
  30000
);

it.each(
  ['DELETE', 'OPTIONS', 'PROPFIND'].flatMap((method) =>
    [true, false].map((length) => ({ method, length }))
  )
)(
  'keeps the response-size floor for $method (declared length: $length)',
  async ({ method, length }) => {
    const f = await fixture({ maxResponseSize: 16384 });
    try {
      const { title, ledger } = await f.run(
        method,
        `/hop/307?next=${encodeURIComponent(`/large?length=${length ? '1' : '0'}`)}`
      );
      expect(f.hits.some((hit) => hit.path === '/large' && hit.method === method)).toBe(true);
      expect(title).not.toBe('settled:leaked');
      expect(ledger).toContain('RESPONSE_TOO_LARGE');
    } finally {
      await f.close();
    }
  },
  30000
);

it('keeps same-origin auth and cookies on a converted GET without restoring body headers', async () => {
  const f = await fixture({ authenticated: true });
  try {
    await f.run('DELETE', `/hop/303?next=${encodeURIComponent('/hop/307?next=/landed')}`);
    const landed = f.hits.find((hit) => hit.path === '/landed');
    expect(landed).toMatchObject({
      method: 'GET',
      bytes: 0,
      authorization: 'Bearer fixture-authorization',
      cookie: 'sid=fixture-owner-cookie',
    });
    expect(landed?.contentType).toBeUndefined();
  } finally {
    await f.close();
  }
}, 30000);

it('selects destination cookies and permanently strips authorization across a converted cross-origin round trip', async () => {
  const f = await fixture({ authenticated: true });
  try {
    const back = `${f.origin}/landed`;
    await f.run(
      'DELETE',
      `/hop/303?${new URLSearchParams({ out: '1', next: `/hop/307?${new URLSearchParams({ next: back })}` })}`
    );
    const other = f.hits.find((hit) => hit.host === 'localhost' && hit.path === '/hop/307');
    const landed = f.hits.find((hit) => hit.path === '/landed');
    expect(other).toMatchObject({ method: 'GET', bytes: 0, cookie: 'sid=fixture-other-cookie' });
    expect(other?.authorization).toBeUndefined();
    expect(landed).toMatchObject({
      host: '127.0.0.1',
      method: 'GET',
      bytes: 0,
      cookie: 'sid=fixture-owner-cookie',
    });
    expect(landed?.authorization).toBeUndefined();
  } finally {
    await f.close();
  }
}, 30000);

it.each(
  (['HEAD', 'DELETE', 'OPTIONS'] as const).flatMap((method) =>
    (['method', 'host', 'budget', 'rate'] as const).map((restriction) => ({ method, restriction }))
  )
)(
  'retains $restriction denial and a valid sealed ledger for a $method redirect chain',
  async ({ method, restriction }) => {
    const f = await fixture();
    try {
      const target = `/hop/307?${new URLSearchParams({ next: '/landed', ...(restriction === 'host' ? { out: '1' } : {}) })}`;
      const { ledger, denials } = await f.run(method, target, restriction);
      const code = {
        method: 'SCOPE_METHOD_DENIED',
        host: 'SCOPE_HOST_DENIED',
        budget: 'SCOPE_BUDGET_EXHAUSTED',
        rate: 'SCOPE_RATE_LIMITED',
      }[restriction];
      expect(denials[code]).toBeGreaterThan(0);
      expect(ledger).toContain(code);
      expect(f.hits.some((hit) => hit.path === '/landed')).toBe(false);
      expect(f.hits.some((hit) => hit.host === 'localhost')).toBe(false);
    } finally {
      await f.close();
    }
  },
  30000
);

it.each([300, 304])(
  'does not follow a Location field on the non-redirect status %i',
  async (status) => {
    const f = await fixture();
    try {
      const { denials } = await f.run('GET', `/hop/${status}?next=/landed`);
      expect(denials).toEqual({});
      expect(f.hits.filter((hit) => hit.path !== '/run')).toEqual([
        expect.objectContaining({ path: `/hop/${status}`, method: 'GET' }),
      ]);
    } finally {
      await f.close();
    }
  },
  30000
);
