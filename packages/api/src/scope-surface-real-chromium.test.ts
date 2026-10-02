import { createServer } from 'node:http';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
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
