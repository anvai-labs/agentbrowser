import { createHash } from 'node:crypto';
import { MetricsRegistry, SessionCoordinator } from '@agentbrowser/core';
import { SessionViewSchema } from '@agentbrowser/protocol';
import { FakeEngine } from '@agentbrowser/testkit';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { AgentBrowserService } from './service.js';

const facts = () => ({
  attachment: 'local_launch',
  browserFamily: 'chromium',
  browserVersion: '123.0.1',
  executableSelection: 'playwright_default',
  launchMode: 'headless',
  resourceModel: 'shared_local_browser',
  context: {
    isolation: 'new_context',
    viewport: { mode: 'fixed', width: 1280, height: 720 },
    initScript: 'not_registered',
  },
});

describe('captured session identity and diagnostics', () => {
  it('publishes the canonical HTTP shape for create/get/list and enforces tenant ownership', async () => {
    const engine = new FakeEngine();
    const create = engine.createSession.bind(engine);
    vi.spyOn(engine, 'createSession').mockImplementation(async (options) => {
      const session = await create(options);
      Object.defineProperty(session, 'diagnostics', { value: facts() });
      return session;
    });
    const server = await buildServer({
      engine,
      apiKeys: new Map([
        [createHash('sha256').update('owner-key').digest('hex'), 'owner'],
        [createHash('sha256').update('other-key').digest('hex'), 'other'],
      ]),
    });
    const headers = { authorization: 'Bearer owner-key' };
    try {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers,
        payload: { tenantId: 'owner' },
      });
      expect(created.statusCode).toBe(201);
      const view = created.json();
      const read = await server.inject({
        method: 'GET',
        url: `/v1/sessions/${view.sessionId}`,
        headers,
      });
      const list = await server.inject({ method: 'GET', url: '/v1/sessions', headers });
      for (const value of [view, read.json(), ...list.json().sessions]) {
        expect(new Ajv2020({ strict: false }).compile(SessionViewSchema)(value)).toBe(true);
        expect(value.diagnostics).toEqual(facts());
        expect(value.lease).toMatchObject({
          expiresAt: Date.parse(view.createdAt) + view.ttlMs,
          idleExpiresAt: Date.parse(view.createdAt) + view.idleTimeoutMs,
          lastActivityAt: Date.parse(view.createdAt),
        });
        expect(value.lease.sampledAt).toBeGreaterThanOrEqual(Date.parse(view.createdAt));
        expect(value.engine).toEqual(view.engine);
        expect(value.engine).not.toHaveProperty('capabilities');
      }
      const denied = await server.inject({
        method: 'GET',
        url: `/v1/sessions/${view.sessionId}`,
        headers: { authorization: 'Bearer other-key' },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain('diagnostics');
      expect(denied.body).not.toContain('idleExpiresAt');
      const otherList = await server.inject({
        method: 'GET',
        url: '/v1/sessions',
        headers: { authorization: 'Bearer other-key' },
      });
      expect(otherList.json().sessions).toEqual([]);
    } finally {
      await server.close();
    }
  });
  it('captures the selected adapter once and shares immutable facts through create/get/list', async () => {
    const primary = new FakeEngine();
    const alternate = new FakeEngine();
    let name = 'alternate';
    let version = '2.0.0';
    Object.defineProperties(alternate, {
      name: { get: () => name },
      version: { get: () => version },
    });
    const diagnostic = facts();
    const create = alternate.createSession.bind(alternate);
    vi.spyOn(alternate, 'createSession').mockImplementation(async (options) => {
      const session = await create(options);
      Object.defineProperty(session, 'diagnostics', { value: diagnostic });
      name = 'changed-during-create';
      version = '9.0.0';
      return session;
    });
    const service = new AgentBrowserService({ engine: primary, engines: { alternate } });
    try {
      const created = await service.createSession({ tenantId: 'owner', engine: 'alternate' });
      const expectedFacts = facts();
      diagnostic.browserVersion = 'mutated';
      diagnostic.context.viewport.width = 1;
      name = 'changed-again';
      version = '10.0.0';
      for (const view of [
        created,
        service.getSession(created.sessionId),
        ...service.listSessions('owner'),
      ]) {
        expect(view?.engine).toEqual({ name: 'alternate', version: '2.0.0' });
        expect(view).toMatchObject({ diagnostics: expectedFacts });
      }
      expect(service.listSessions('another-tenant')).toEqual([]);
      expect(service.listSessions('owner')[0]).not.toHaveProperty('tenantId');
      expect(created.tenantId).toBe('owner');
    } finally {
      await service.shutdown();
    }
  });

  it.each(['absent', 'private-field', 'overlong', 'throws'])(
    'omits unsupported or invalid diagnostics (%s) without losing the session',
    async (kind) => {
      const engine = new FakeEngine();
      const create = engine.createSession.bind(engine);
      vi.spyOn(engine, 'createSession').mockImplementation(async (options) => {
        const session = await create(options);
        if (kind === 'throws')
          Object.defineProperty(session, 'diagnostics', {
            get() {
              throw new Error('private endpoint');
            },
          });
        if (kind === 'private-field')
          Object.defineProperty(session, 'diagnostics', {
            value: { ...facts(), endpoint: 'private endpoint' },
          });
        if (kind === 'overlong')
          Object.defineProperty(session, 'diagnostics', {
            value: { ...facts(), browserVersion: 'x'.repeat(129) },
          });
        return session;
      });
      const service = new AgentBrowserService({ engine });
      try {
        const created = await service.createSession({ tenantId: 'owner' });
        for (const view of [
          created,
          service.getSession(created.sessionId),
          ...service.listSessions('owner'),
        ]) {
          expect(view).not.toHaveProperty('diagnostics');
        }
      } finally {
        await service.shutdown();
      }
    }
  );
});

describe('session lease view', () => {
  it('projects create/get/list without refreshing idle activity', async () => {
    let now = 10_000;
    const coordinator = new SessionCoordinator({ now: () => now });
    const service = new AgentBrowserService({ engine: new FakeEngine(), coordinator });
    try {
      const created = await service.createSession({
        tenantId: 'owner',
        ttlMs: 1000,
        idleTimeoutMs: 100,
      });
      expect(created.lease).toEqual({
        sampledAt: 10_000,
        expiresAt: 11_000,
        lastActivityAt: 10_000,
        idleExpiresAt: 10_100,
      });
      now = 10_050;
      for (const view of [
        service.getSession(created.sessionId),
        ...service.listSessions('owner'),
      ]) {
        expect(view?.lease).toEqual({ ...created.lease, sampledAt: now });
      }
      expect(service.listSessions('other')).toEqual([]);
      now = 10_101;
      expect(service.getSession(created.sessionId)).toBeUndefined();
      expect(service.listSessions('owner')).toEqual([]);
    } finally {
      await service.shutdown();
    }
  });
});

it.each([2, 3])(
  'releases session allocation when clock sample %s fails during service creation',
  async (failAt) => {
    let calls = 0;
    const coordinator = new SessionCoordinator({
      now: () => (++calls === failAt ? Number.NaN : 1000),
    });
    const engine = new FakeEngine();
    const create = engine.createSession.bind(engine);
    let close: ReturnType<typeof vi.spyOn>;
    let allocated: Awaited<ReturnType<typeof create>>;
    vi.spyOn(engine, 'createSession').mockImplementation(async (options) => {
      const session = await create(options);
      allocated = session;
      close = vi.spyOn(session, 'close');
      return session;
    });
    const metrics = new MetricsRegistry();
    const increment = vi.spyOn(metrics, 'incrementCounter');
    const service = new AgentBrowserService({ engine, coordinator, metrics });
    try {
      await expect(
        service.createSession({ tenantId: 'owner', controlMode: 'delegated', allowDownloads: true })
      ).rejects.toThrow('An unexpected engine error occurred');
      expect(coordinator.getSessionCount()).toBe(0);
      expect(close!).toHaveBeenCalledTimes(1);
      await expect(allocated!.newPage()).rejects.toThrow('Session is closed');
      expect(increment).not.toHaveBeenCalledWith('sessions_created_total');
      expect(service.listSessions('owner')).toEqual([]);
    } finally {
      await service.shutdown();
    }
  }
);
