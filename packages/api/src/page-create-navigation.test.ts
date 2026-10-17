import { createServer } from 'node:http';
import type { EnginePage } from '@agentbrowser/engine';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { NavigationFailureReasonSchema } from '@agentbrowser/protocol';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

const reasons = NavigationFailureReasonSchema.anyOf.map((item) => item.const);
const cases = [
  ...reasons.map((reason) => ({
    status: 'blocked' as const,
    reason,
    scope: undefined,
    expectedReason: reason,
    expectedCode: reason === 'egress_policy' ? 'POLICY_DENIED' : 'INTERNAL',
    expectedStatus: reason === 'egress_policy' ? 403 : 500,
  })),
  ...[undefined, 'private-fixture-marker', { secret: 'private-fixture-marker' }].map((reason) => ({
    status: 'blocked' as const,
    reason,
    scope: 'SCOPE_HOST_DENIED private-fixture-marker',
    expectedReason: 'engine_error',
    expectedCode: 'INTERNAL',
    expectedStatus: 500,
  })),
  ...['dns_timeout', undefined].map((reason) => ({
    status: 'timeout' as const,
    reason,
    // An unrelated scope code must not turn a timeout into a policy denial.
    scope: 'SCOPE_HOST_DENIED',
    expectedReason: reason ?? 'engine_error',
    expectedCode: 'NAVIGATION_TIMEOUT',
    expectedStatus: 504,
  })),
];

it.each(cases)(
  'REST page creation rejects $status/$expectedReason with $expectedStatus and retains its sibling',
  async ({ status, reason, scope, expectedReason, expectedCode, expectedStatus }) => {
    const engine = new FakeEngine();
    const pages: EnginePage[] = [];
    const create = engine.createSession.bind(engine);
    vi.spyOn(engine, 'createSession').mockImplementation(async (options) => {
      const session = await create(options);
      const newPage = session.newPage.bind(session);
      vi.spyOn(session, 'newPage').mockImplementation(async () => {
        const page = await newPage();
        pages.push(page);
        vi.spyOn(page, 'close');
        vi.spyOn(page, 'navigate').mockResolvedValue({
          status,
          reason,
          scope,
          url: 'https://example.com/private-fixture-marker',
          redirectChain: ['https://example.com/private-fixture-marker'],
          driverData: 'private-fixture-marker',
        } as Awaited<ReturnType<EnginePage['navigate']>>);
        return page;
      });
      return session;
    });
    const app = await buildServer({ engine });
    try {
      const session = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: { tenantId: 'local' },
      });
      expect(session.statusCode).toBe(201);
      const sessionPath = `/v1/sessions/${session.json().sessionId}`;
      const sibling = await app.inject({
        method: 'POST',
        url: `${sessionPath}/pages`,
        payload: {},
      });
      expect(sibling.statusCode).toBe(201);
      const reply = await app.inject({
        method: 'POST',
        url: `${sessionPath}/pages`,
        payload: { url: 'https://example.com/start' },
      });
      expect(reply.statusCode).toBe(expectedStatus);
      expect(reply.json().error).toEqual({
        code: expectedCode,
        message: `Navigation failed: ${expectedReason}`,
        retryable: false,
        details: { reason: expectedReason },
      });
      expect(reply.body).not.toContain('private-fixture-marker');
      expect(pages).toHaveLength(2);
      expect(pages[0]!.navigate).not.toHaveBeenCalled();
      expect(pages[0]!.close).not.toHaveBeenCalled();
      expect(pages[1]!.navigate).toHaveBeenCalledOnce();
      expect(pages[1]!.close).toHaveBeenCalledOnce();
      const listed = await app.inject({ method: 'GET', url: `${sessionPath}/pages` });
      expect(listed.json().pages.map((page: { pageId: string }) => page.pageId)).toEqual([
        sibling.json().pageId,
      ]);
      expect((await app.inject({ method: 'GET', url: sessionPath })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }
);

it('successful navigation still creates a ready page and drops contradictory failure metadata', async () => {
  const { AgentBrowserService } = await import('./service.js');
  const service = new AgentBrowserService({ engine: new FakeEngine() });
  try {
    const { sessionId } = await service.createSession({ tenantId: 'local' });
    vi.spyOn(service, 'navigate').mockResolvedValue({
      status: 'success',
      reason: 'egress_policy',
      scope: 'SCOPE_HOST_DENIED',
      url: 'https://example.com/',
      redirectChain: [],
    });
    const page = await service.createPage(sessionId, { url: 'https://example.com/' });
    expect(page).toEqual({ sessionId, pageId: expect.any(String), status: 'ready' });
    expect(await service.listPages(sessionId)).toHaveLength(1);
  } finally {
    await service.shutdown();
  }
});

it('a real Chromium non-scope redirect denial fails page creation without contacting the target or closing its sibling', async () => {
  let deniedHits = 0;
  let redirects = 0;
  const fixture = createServer((request, response) => {
    if (request.url === '/redirect') {
      redirects += 1;
      const port = (fixture.address() as { port: number }).port;
      response.writeHead(302, {
        location: `http://localhost:${port}/denied?private-fixture-marker`,
      });
      response.end();
      return;
    }
    if (request.url?.startsWith('/denied')) deniedHits += 1;
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        '<html><head><link rel="icon" href="data:,"></head><body><button>Sibling</button></body></html>'
      );
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const port = (fixture.address() as { port: number }).port;
  const app = await buildServer({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false }),
  });
  try {
    const session = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'local', policy: { blockedHosts: ['localhost'] } },
    });
    expect(session.statusCode).toBe(201);
    const sessionPath = `/v1/sessions/${session.json().sessionId}`;
    const sibling = await app.inject({
      method: 'POST',
      url: `${sessionPath}/pages`,
      payload: { url: `http://127.0.0.1:${port}/sibling` },
    });
    expect(sibling.statusCode).toBe(201);
    const reply = await app.inject({
      method: 'POST',
      url: `${sessionPath}/pages`,
      payload: { url: `http://127.0.0.1:${port}/redirect` },
    });
    expect(reply.statusCode).toBe(403);
    expect(reply.json().error).toEqual({
      code: 'POLICY_DENIED',
      message: 'Navigation failed: egress_policy',
      retryable: false,
      details: { reason: 'egress_policy' },
    });
    expect(reply.body).not.toContain('private-fixture-marker');
    expect(redirects).toBe(1);
    expect(deniedHits).toBe(0);
    const listed = await app.inject({ method: 'GET', url: `${sessionPath}/pages` });
    expect(listed.json().pages.map((page: { pageId: string }) => page.pageId)).toEqual([
      sibling.json().pageId,
    ]);
    const observed = await app.inject({
      method: 'POST',
      url: `${sessionPath}/pages/${sibling.json().pageId}/observe`,
      payload: {},
    });
    expect(observed.statusCode).toBe(200);
    expect(observed.json().elements).toContainEqual(expect.objectContaining({ name: 'Sibling' }));
  } finally {
    await app.close();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}, 30_000);
