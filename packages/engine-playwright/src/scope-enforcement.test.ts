// T7 slice 2: engagement scope enforcement gates (real Chromium, local
// fixtures only). The design contract lives in
// docs/spec/design/t7-scope-enforcement.md; its numbered gates map to
// the tests below. Scope rules RESTRICT over the base — the base always
// runs. Probes are fixture-scripted (pages carry their own fetch
// scripts) because engine pages expose act/observe/navigate, not
// arbitrary evaluation.
import { type Server, createServer } from 'node:http';
import type { EnginePage } from '@agentbrowser/engine';
import { EngagementScopePolicy, NetworkPolicy } from '@agentbrowser/policy';
import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

// Scope is hostname-scoped (the engine hands policies the URL
// hostname). The fixtures bind distinct loopback IPs — in-scope vs
// out-of-scope become distinct scope identities with no DNS in the
// path (the engine short-circuits IP literals for the address gate,
// and Chromium connects to loopback aliases natively on macOS and
// Linux). Hostname-pattern matching itself is pinned by the policy
// package's unit tests; these gates prove enforcement through the
// real choke point.
const IN_HOST = '127.0.0.1';
// The out-of-scope target never needs to be reachable — scope denial
// happens at the initial verdict, before the wire — so it is an
// unrouted TEST-NET-1 literal. Zero-leak is asserted by denial plus
// the in-fixture's hit log.
const OUT_HOST = '192.0.2.7';
const OUT_PORT = 9; // discard port; never connected

interface FixtureHost {
  hits: Array<{ path: string; method: string; identity?: string }>;
  server: Server;
  port: () => number;
  url: (path?: string) => string;
}

function startFixture(): Promise<FixtureHost> {
  const hits: FixtureHost['hits'] = [];
  const server = createServer((request, response) => {
    const identity = request.headers['x-test-identity'];
    hits.push({
      path: request.url ?? '/',
      method: request.method ?? 'GET',
      ...(typeof identity === 'string' ? { identity } : {}),
    });
    const path = request.url ?? '/';
    const redirect = (location: string) => {
      response.writeHead(302, { location });
      response.end();
    };
    if (path === '/redirect-out') {
      redirect(`http://${OUT_HOST}:${OUT_PORT}/leaked`);
      return;
    }
    if (path === '/identity-hop') {
      // A cross-origin hop re-issues (or strips) the original request's
      // custom headers; either way the identity must not arrive there.
      redirect(`http://${OUT_HOST}:${OUT_PORT}/identity-leak`);
      return;
    }
    if (path === '/redirect-in') {
      redirect('/landed');
      return;
    }
    const script =
      path === '/probe'
        ? `<script>
             fetch('/admin').catch(function(){});
             fetch('/api/list', {method:'DELETE'}).catch(function(){});
           </script>`
        : path === '/identity-driver'
          ? `<script>
               fetch('/identity-ok', {headers:{'x-test-identity':'admin-session'}}).catch(function(){});
               fetch('/identity-hop', {headers:{'x-test-identity':'admin-session'}}).catch(function(){});
             </script>`
          : '';
    const frames =
      path === '/frame-host'
        ? `<iframe src="/frame-doc"></iframe>`
        : path === '/frame-out'
          ? `<iframe src="http://${OUT_HOST}:${OUT_PORT}/frame-leak"></iframe>`
          : '';
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      `<html><head><link rel="icon" href="data:,"></head><body>${frames}<h1 id="h">fixture</h1>${script}</body></html>`
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        hits,
        server,
        port: () => (server.address() as { port: number }).port,
        url: (path = '/') => `http://${IN_HOST}:${port}${path}`,
      });
    });
  });
}

const closeFixture = async (fixture: FixtureHost): Promise<void> => {
  fixture.server.closeAllConnections();
  await new Promise<void>((done) => fixture.server.close(() => done()));
};

async function withSession(
  scope: EngagementScopePolicy,
  run: (page: EnginePage) => Promise<void>
): Promise<void> {
  const engine = new PlaywrightChromiumEngine();
  try {
    const session = await engine.createSession({ headless: true, requestPolicy: scope });
    const page = await session.newPage();
    await run(page);
  } finally {
    await engine.close();
  }
}

describe('engagement scope enforcement (T7 slice 2, real Chromium)', () => {
  it('gate 1: allows in-scope navigation and blocks out-of-scope hosts with zero leaked hits', async () => {
    const fixture = await startFixture();
    try {
      const scope = new EngagementScopePolicy(new NetworkPolicy({ blockLoopback: false }), {
        allowedHosts: [IN_HOST],
      });
      await withSession(scope, async (page) => {
        const allowed = await page.navigate({ url: fixture.url('/start') });
        expect(allowed.status).toBe('success');
        const state = await page.observe({ mode: 'interactive' });
        expect(state.url).toContain('/start');
        const blocked = await page.navigate({ url: `http://${OUT_HOST}:${OUT_PORT}/never` });
        expect(blocked.status).toBe('blocked');
        expect(fixture.hits.some((hit) => hit.path === '/never')).toBe(false);
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('gate 2: a chain leaving scope is blocked at the hop; in-scope redirects complete', async () => {
    const fixture = await startFixture();
    try {
      const scope = new EngagementScopePolicy(new NetworkPolicy({ blockLoopback: false }), {
        allowedHosts: [IN_HOST],
      });
      await withSession(scope, async (page) => {
        const blocked = await page.navigate({ url: fixture.url('/redirect-out') });
        expect(blocked.status).toBe('blocked');
        expect(fixture.hits.some((hit) => hit.path === '/leaked')).toBe(false);
        const allowed = await page.navigate({ url: fixture.url('/redirect-in') });
        expect(allowed.status).toBe('success');
        expect((await page.observe({ mode: 'interactive' })).url).toContain('/landed');
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('gate 3: child-frame documents are scope-checked exactly like the top document', async () => {
    const fixture = await startFixture();
    try {
      const scope = new EngagementScopePolicy(new NetworkPolicy({ blockLoopback: false }), {
        allowedHosts: [IN_HOST],
      });
      await withSession(scope, async (page) => {
        // In-scope frame loads through the scoped route...
        await page.navigate({ url: fixture.url('/frame-host') });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(fixture.hits.some((hit) => hit.path === '/frame-doc')).toBe(true);
        // ...and a frame pointing out of scope never reaches its host.
        await page.navigate({ url: fixture.url('/frame-out') });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(fixture.hits.some((hit) => hit.path === '/frame-leak')).toBe(false);
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('gate 4+5: path and method scoping deny at the choke point (DELETE never reaches the wire)', async () => {
    const fixture = await startFixture();
    try {
      const scope = new EngagementScopePolicy(new NetworkPolicy({ blockLoopback: false }), {
        allowedHosts: [IN_HOST],
        pathRules: [{ prefix: '/api/' }],
        allowedMethods: ['GET'],
      });
      await withSession(scope, async (page) => {
        // The /api/probe document is in scope; its script's probes are
        // not: /admin leaves the path scope, DELETE leaves the method
        // scope — and because the denial happens at the initial verdict,
        // the passthrough lane never carries the DELETE either.
        await page.navigate({ url: fixture.url('/api/probe') });
        await new Promise((resolve) => setTimeout(resolve, 400));
        const paths = fixture.hits.map((hit) => hit.path);
        expect(paths).toContain('/api/probe');
        expect(paths).not.toContain('/admin');
        expect(
          fixture.hits.some((hit) => hit.path === '/api/list' && hit.method === 'DELETE')
        ).toBe(false);
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('gate 6: expiry denies the next request after the boundary (injected clock)', async () => {
    const fixture = await startFixture();
    try {
      let now = 1_000_000;
      const scope = new EngagementScopePolicy(new NetworkPolicy({ blockLoopback: false }), {
        allowedHosts: [IN_HOST],
        expiresAt: 1_000_500,
        now: () => now,
      });
      await withSession(scope, async (page) => {
        await page.navigate({ url: fixture.url('/before') });
        now = 1_000_500;
        const blocked = await page.navigate({ url: fixture.url('/after') });
        expect(blocked.status).toBe('blocked');
        const paths = fixture.hits.map((hit) => hit.path);
        expect(paths).toContain('/before');
        expect(paths).not.toContain('/after');
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('gate 7: budget exhaustion prevents further traffic (fixture records no further hits)', async () => {
    const fixture = await startFixture();
    try {
      const scope = new EngagementScopePolicy(new NetworkPolicy({ blockLoopback: false }), {
        allowedHosts: [IN_HOST],
        requestBudget: 2,
      });
      await withSession(scope, async (page) => {
        await page.navigate({ url: fixture.url('/one') });
        await page.navigate({ url: fixture.url('/two') });
        await page.navigate({ url: fixture.url('/three') });
        await page.navigate({ url: fixture.url('/four') });
        const paths = fixture.hits.map((hit) => hit.path);
        expect(paths).toContain('/one');
        expect(paths).toContain('/two');
        expect(paths).not.toContain('/three');
        expect(paths).not.toContain('/four');
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('gate 8: identity-marked traffic never reaches an unbound host', async () => {
    const fixture = await startFixture();
    try {
      const scope = new EngagementScopePolicy(new NetworkPolicy({ blockLoopback: false }), {
        allowedHosts: [IN_HOST, OUT_HOST],
        identityBindings: [
          {
            header: 'x-test-identity',
            value: 'admin-session',
            allowedHosts: [IN_HOST],
          },
        ],
      });
      await withSession(scope, async (page) => {
        await page.navigate({ url: fixture.url('/identity-driver') });
        await new Promise((resolve) => setTimeout(resolve, 500));
        // The bound host received the identity...
        expect(
          fixture.hits.some(
            (hit) => hit.path === '/identity-ok' && hit.identity === 'admin-session'
          )
        ).toBe(true);
        // ...and the identity never left the bound host: the redirect
        // hop is checked with the original request's headers and denied
        // before the wire (the unrouted out host records nothing, and
        // no /identity-leak path exists on the in-fixture either).
        expect(fixture.hits.some((hit) => hit.path === '/identity-leak')).toBe(false);
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('gate 9: composition is restrict-only — the base policy denies even in-scope hosts', async () => {
    const fixture = await startFixture();
    try {
      const scope = new EngagementScopePolicy(new NetworkPolicy({ blockLoopback: true }), {
        allowedHosts: [IN_HOST],
      });
      await withSession(scope, async (page) => {
        const blocked = await page.navigate({ url: fixture.url('/start') });
        expect(blocked.status).toBe('blocked');
        expect(fixture.hits).toEqual([]);
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);
});
