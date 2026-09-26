import { EngineError } from '@agentbrowser/engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

it('publishes navigation reasons without changing success or exposing engine topology', async () => {
  const engine = new FakeEngine();
  let navigate: ReturnType<typeof vi.spyOn>;
  const create = engine.createSession.bind(engine);
  vi.spyOn(engine, 'createSession').mockImplementation(async (options) => {
    const session = await create(options);
    const newPage = session.newPage.bind(session);
    vi.spyOn(session, 'newPage').mockImplementation(async () => {
      const page = await newPage();
      navigate = vi.spyOn(page, 'navigate');
      return page;
    });
    return session;
  });
  const server = await buildServer({ engine });
  try {
    const created = (
      await server.inject({ method: 'POST', url: '/v1/sessions', payload: { tenantId: 'default' } })
    ).json();
    expect(created.sessionId, JSON.stringify(created)).toBeTypeOf('string');
    const page = (
      await server.inject({
        method: 'POST',
        url: `/v1/sessions/${created.sessionId}/pages`,
        payload: {},
      })
    ).json();
    expect(page.pageId, JSON.stringify(page)).toBeTypeOf('string');
    const url = `/v1/sessions/${created.sessionId}/pages/${page.pageId}/navigate`;
    for (const reason of [
      'dns_nxdomain',
      'dns_unresolved',
      'connection_refused',
      'dns_timeout',
      'dns_refused',
      'tls_refused',
      'browser_error_document',
      'engine_error',
    ]) {
      navigate!.mockRejectedValueOnce(
        new EngineError('INTERNAL', 'private address 10.0.0.1', false, { reason })
      );
      const reply = await server.inject({
        method: 'POST',
        url,
        payload: { url: 'https://example.com/' },
      });
      expect(reply.json().error.details.reason).toBe(reason);
      expect(reply.body).not.toContain('10.0.0.1');
    }
    navigate!.mockResolvedValueOnce({
      status: 'blocked',
      url: 'https://example.com/',
      redirectChain: [],
      reason: 'egress_policy',
    });
    expect(
      (
        await server.inject({ method: 'POST', url, payload: { url: 'https://example.com/' } })
      ).json().reason
    ).toBe('egress_policy');
    navigate!.mockResolvedValueOnce({
      status: 'blocked',
      url: 'https://example.com/',
      redirectChain: [],
      reason: 'private-host',
    });
    const malformed = await server.inject({
      method: 'POST',
      url,
      payload: { url: 'https://example.com/' },
    });
    expect(malformed.json().reason).toBe('engine_error');
    expect(malformed.body).not.toContain('private-host');
    const policy = await server.inject({
      method: 'POST',
      url,
      payload: { url: 'http://127.0.0.1/' },
    });
    expect(policy.json().error.details.reason).toBe('egress_policy');
    navigate!.mockResolvedValueOnce({
      status: 'success',
      url: 'https://example.com/',
      redirectChain: [],
    });
    expect(
      (
        await server.inject({ method: 'POST', url, payload: { url: 'https://example.com/' } })
      ).json()
    ).not.toHaveProperty('reason');
  } finally {
    await server.close();
  }
});

it('invalidates service refs on a dispatched failed navigation without misclassifying a connection as engine death', async () => {
  const { AgentBrowserService } = await import('./service.js');
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  try {
    const session = await service.createSession({ tenantId: 't' });
    const page = await service.createPage(session.sessionId);
    await service.navigate(session.sessionId, page.pageId, { url: 'https://example.com/' });
    const before = await service.observe(session.sessionId, page.pageId, {});
    const native = engine.getFakePage(engine.getSessionIds()[0]!, page.pageId)!;
    vi.spyOn(native, 'navigate').mockRejectedValue(
      new Error('page.goto: net::ERR_CONNECTION_CLOSED at https://browser.closed.example/')
    );
    await expect(
      service.navigate(session.sessionId, page.pageId, { url: 'https://example.com/' })
    ).rejects.toMatchObject({ code: 'INTERNAL', details: { reason: 'engine_error' } });
    expect(service.getSession(session.sessionId)).toBeDefined();
    const after = await service.observe(session.sessionId, page.pageId, {});
    expect(after.revision).toBeGreaterThan(before.revision);
  } finally {
    await service.shutdown();
  }
});
