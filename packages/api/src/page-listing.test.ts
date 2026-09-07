import { createHash } from 'node:crypto';
import { SecretManager } from '@agentbrowser/core';
import type { EnginePage } from '@agentbrowser/engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from './server';
import { AgentBrowserService } from './service';

function fixture(configure: (page: EnginePage) => void) {
  const engine = new FakeEngine();
  const createSession = engine.createSession.bind(engine);
  vi.spyOn(engine, 'createSession').mockImplementation(async (options) => {
    const session = await createSession(options);
    const newPage = session.newPage.bind(session);
    vi.spyOn(session, 'newPage').mockImplementation(async (options) => {
      const page = await newPage(options);
      configure(page);
      return page;
    });
    return session;
  });
  return engine;
}

describe('page listing output boundary', () => {
  it('redacts registered secrets in cached URLs at the REST boundary', async () => {
    const url = 'https://example.com/?token=synthetic-secret';
    const engine = fixture((page) => {
      Object.assign(page, { getCachedUrl: () => url, getUrl: async () => url });
    });
    const server = await buildServer({
      engine,
      secretManager: new SecretManager({ 'vault://token': 'synthetic-secret' }),
    });
    try {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: { tenantId: 'owner' },
      });
      const { sessionId } = created.json();
      await server.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/pages` });
      const listed = await server.inject(`/v1/sessions/${sessionId}/pages`);
      expect(listed.statusCode).toBe(200);
      expect(listed.json().pages[0].url).toBe('https://example.com/?token=***');
      expect(listed.body).not.toContain('synthetic-secret');
    } finally {
      await server.close();
    }
  });

  it('never waits for an asynchronous URL lookup to discover page IDs', async () => {
    const getUrl = vi.fn(() => new Promise<string>(() => {}));
    const engine = fixture((page) => Object.assign(page, { getUrl }));
    const service = new AgentBrowserService({ engine });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { sessionId } = await service.createSession({ tenantId: 'owner' });
      const { pageId } = await service.createPage(sessionId);
      const result = await Promise.race([
        service.listPages(sessionId),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('listing blocked on URL I/O'), 100);
        }),
      ]);
      expect(result).toEqual([{ pageId, sessionId, status: 'active', url: 'about:blank' }]);
      expect(getUrl).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      await service.shutdown();
    }
  });

  it.each(['absent', 'undefined', 'throwing', 'null', 'promise'] as const)(
    'omits unavailable cached URLs (%s) without falling back to live I/O',
    async (mode) => {
      const getUrl = vi.fn(async () => 'https://must-not-query.example/');
      const engine = fixture((page) => {
        Object.assign(page, {
          getUrl,
          getCachedUrl:
            mode === 'absent'
              ? undefined
              : () => {
                  if (mode === 'throwing') throw new Error('cache unavailable');
                  if (mode === 'null') return null;
                  if (mode === 'promise')
                    return Promise.resolve('https://invalid-adapter.example/');
                  return undefined;
                },
        });
      });
      const service = new AgentBrowserService({ engine });
      try {
        const { sessionId } = await service.createSession({ tenantId: 'owner' });
        const { pageId } = await service.createPage(sessionId);
        expect(await service.listPages(sessionId)).toEqual([
          { pageId, sessionId, status: 'active' },
        ]);
        expect(getUrl).not.toHaveBeenCalled();
      } finally {
        await service.shutdown();
      }
    }
  );

  it('preserves creation order and excludes closed pages and other sessions', async () => {
    const service = new AgentBrowserService({ engine: new FakeEngine() });
    try {
      const a = await service.createSession({ tenantId: 'a' });
      const b = await service.createSession({ tenantId: 'b' });
      const first = await service.createPage(a.sessionId);
      await service.createPage(b.sessionId);
      const closed = await service.createPage(a.sessionId);
      const last = await service.createPage(a.sessionId);
      await service.closePage(a.sessionId, closed.pageId);
      expect((await service.listPages(a.sessionId)).map((page) => page.pageId)).toEqual([
        first.pageId,
        last.pageId,
      ]);
    } finally {
      await service.shutdown();
    }
  });

  it("does not expose another tenant's page list", async () => {
    const digest = (key: string) => createHash('sha256').update(key).digest('hex');
    const server = await buildServer({
      engine: new FakeEngine(),
      apiKeys: new Map([
        [digest('key-a'), 'a'],
        [digest('key-b'), 'b'],
      ]),
    });
    try {
      const headers = { authorization: 'Bearer key-a' };
      const created = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers,
        payload: { tenantId: 'a' },
      });
      const { sessionId } = created.json();
      const page = await server.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/pages`,
        headers,
      });
      const denied = await server.inject({
        url: `/v1/sessions/${sessionId}/pages`,
        headers: { authorization: 'Bearer key-b' },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain(page.json().pageId);
    } finally {
      await server.close();
    }
  });
});
