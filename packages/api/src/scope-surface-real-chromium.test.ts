import { createServer } from 'node:http';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { buildServer } from './server.js';
import { AgentBrowserService, ServiceError } from './service.js';

// Service navigation preflights the session policy before dispatching, so
// scope denials surface as typed POLICY_DENIED ServiceErrors carrying the
// SCOPE_* sub-code — the request never reaches the engine.
async function denialOf(run: () => Promise<unknown>): Promise<ServiceError> {
  return run().then(
    () => {
      throw new Error('expected the navigation to be denied');
    },
    (error: unknown) => {
      if (error instanceof ServiceError) return error;
      throw error;
    }
  );
}

// T7 slice 2a service surface: the wire shape (session create with
// policy.scope) composes EngagementScopePolicy as the outermost
// restrict-only layer and enforces it end-to-end on real Chromium,
// local fixtures only. The excluded host is an unrouted TEST-NET-1
// literal — denial precedes the wire.

const OUT = 'http://192.0.2.7:9/never';

async function startFixture(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === '/redirect-out') {
      response.writeHead(302, { location: OUT });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      '<html><head><link rel="icon" href="data:,"></head><body><h1>fixture</h1></body></html>'
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

const closeFixture = (server: ReturnType<typeof createServer>): Promise<void> => {
  server.closeAllConnections();
  return new Promise<void>((done) => server.close(() => done()));
};

it('scope: in-scope navigation succeeds; the excluded host is blocked at the surface', async () => {
  const { server, port } = await startFixture();
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy(),
  });
  try {
    const { sessionId } = await service.createSession({
      tenantId: 'local',
      scope: { allowedHosts: ['127.0.0.1'] },
    });
    const { pageId } = await service.createPage(sessionId);
    const allowed = await service.navigate(sessionId, pageId, {
      url: `http://127.0.0.1:${port}/start`,
    });
    expect(allowed.status).toBe('success');
    const denial = await denialOf(() => service.navigate(sessionId, pageId, { url: OUT }));
    expect(denial.code).toBe('POLICY_DENIED');
    expect(denial.message).toContain('SCOPE_HOST_DENIED');
  } finally {
    await service.shutdown().catch(() => {});
    await closeFixture(server);
  }
}, 30_000);

it('scope: budget exhaustion prevents further traffic through the service surface', async () => {
  const { server, port } = await startFixture();
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy(),
  });
  try {
    const { sessionId } = await service.createSession({
      tenantId: 'local',
      scope: { allowedHosts: ['127.0.0.1'], requestBudget: 2 },
    });
    const { pageId } = await service.createPage(sessionId);
    await service.navigate(sessionId, pageId, { url: `http://127.0.0.1:${port}/one` });
    await service.navigate(sessionId, pageId, { url: `http://127.0.0.1:${port}/two` });
    const denial = await denialOf(() =>
      service.navigate(sessionId, pageId, { url: `http://127.0.0.1:${port}/three` })
    );
    expect(denial.message).toContain('SCOPE_BUDGET_EXHAUSTED');
  } finally {
    await service.shutdown().catch(() => {});
    await closeFixture(server);
  }
}, 30_000);

it('scope: method-scoped engagements allow document navigations (GET preflight)', async () => {
  const { server, port } = await startFixture();
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy(),
  });
  try {
    const { sessionId } = await service.createSession({
      tenantId: 'local',
      scope: { allowedHosts: ['127.0.0.1'], allowedMethods: ['GET'] },
    });
    const { pageId } = await service.createPage(sessionId);
    // The preflight carries the document method: a GET-only engagement
    // must not false-deny GET navigations at the surface.
    const allowed = await service.navigate(sessionId, pageId, {
      url: `http://127.0.0.1:${port}/get`,
    });
    expect(allowed.status).toBe('success');
  } finally {
    await service.shutdown().catch(() => {});
    await closeFixture(server);
  }
}, 30_000);

it('scope: an expired engagement scope denies the first navigation', async () => {
  const { server, port } = await startFixture();
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy(),
  });
  try {
    const { sessionId } = await service.createSession({
      tenantId: 'local',
      scope: { allowedHosts: ['127.0.0.1'], expiresAt: 1 },
    });
    const { pageId } = await service.createPage(sessionId);
    const denial = await denialOf(() =>
      service.navigate(sessionId, pageId, { url: `http://127.0.0.1:${port}/late` })
    );
    expect(denial.message).toContain('SCOPE_EXPIRED');
  } finally {
    await service.shutdown().catch(() => {});
    await closeFixture(server);
  }
}, 30_000);

it('T10 M2: a navigation blocked at a redirect hop reports the scope sub-code', async () => {
  const { server, port } = await startFixture();
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false }),
  });
  try {
    const { sessionId } = await service.createSession({
      tenantId: 'local',
      scope: { allowedHosts: ['127.0.0.1'] },
    });
    const { pageId } = await service.createPage(sessionId);
    const blocked = await service.navigate(sessionId, pageId, {
      url: `http://127.0.0.1:${port}/redirect-out`,
    });
    expect(blocked).toMatchObject({
      status: 'blocked',
      reason: 'egress_policy',
      scope: 'SCOPE_HOST_DENIED',
    });
  } finally {
    await service.shutdown().catch(() => {});
    await closeFixture(server);
  }
}, 30_000);

it('T10 M2: page creation reports a scoped redirect denial and closes only the failed page', async () => {
  const { server, port } = await startFixture();
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false }),
  });
  try {
    const { sessionId } = await service.createSession({
      tenantId: 'local',
      scope: { allowedHosts: ['127.0.0.1'] },
    });
    const sibling = await service.createPage(sessionId, {
      url: `http://127.0.0.1:${port}/start`,
    });
    const denial = await denialOf(() =>
      service.createPage(sessionId, { url: `http://127.0.0.1:${port}/redirect-out` })
    );
    expect(denial).toMatchObject({
      code: 'POLICY_DENIED',
      retryable: false,
      details: { reason: 'egress_policy', scope: 'SCOPE_HOST_DENIED' },
    });
    expect((await service.listPages(sessionId)).map((page) => page.pageId)).toEqual([
      sibling.pageId,
    ]);
    expect(service.getSession(sessionId)?.pages).toBe(1);
    expect(
      await service.navigate(sessionId, sibling.pageId, { url: `http://127.0.0.1:${port}/after` })
    ).toMatchObject({ status: 'success' });
  } finally {
    await service.shutdown().catch(() => {});
    await closeFixture(server);
  }
}, 30_000);

it('T10 M2: REST page creation returns the redirect scope denial without contacting its target', async () => {
  let deniedHits = 0;
  const server = createServer((request, response) => {
    if (request.url === '/redirect-out') {
      response.writeHead(302, { location: '/denied' });
    } else {
      if (request.url === '/denied') deniedHits += 1;
      response.writeHead(200, { 'content-type': 'text/html' });
    }
    response.end('<html><head><link rel="icon" href="data:,"></head><body>fixture</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const app = await buildServer({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false }),
  });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: {
        tenantId: 'local',
        policy: {
          scope: {
            allowedHosts: ['127.0.0.1'],
            pathRules: [{ prefix: '/redirect-out' }],
          },
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const { sessionId } = created.json();
    const denied = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/pages`,
      payload: { url: `http://127.0.0.1:${port}/redirect-out` },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: {
        code: 'POLICY_DENIED',
        retryable: false,
        details: { reason: 'egress_policy', scope: 'SCOPE_PATH_DENIED' },
      },
    });
    expect(denied.json()).not.toHaveProperty('pageId');
    expect(deniedHits).toBe(0);
    const pages = await app.inject({ method: 'GET', url: `/v1/sessions/${sessionId}/pages` });
    expect(pages.json()).toEqual({ pages: [] });
  } finally {
    await app.close();
    await closeFixture(server);
  }
}, 30_000);
