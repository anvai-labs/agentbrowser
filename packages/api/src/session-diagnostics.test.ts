import { createHash } from 'node:crypto';
import { MetricsRegistry, SessionCoordinator } from '@agentbrowser/core';
import { EngineError } from '@agentbrowser/engine';
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
        expect(value.leaseRemainingMs).toBe(
          Math.max(
            0,
            Math.min(value.lease.expiresAt, value.lease.idleExpiresAt) - value.lease.sampledAt
          )
        );
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
      expect(created.leaseRemainingMs).toBe(100);
      now = 10_050;
      for (const view of [
        service.getSession(created.sessionId),
        ...service.listSessions('owner'),
      ]) {
        expect(view?.lease).toEqual({ ...created.lease, sampledAt: now });
        expect(view?.leaseRemainingMs).toBe(50);
      }
      expect(service.listSessions('other')).toEqual([]);
      now = 10_101;
      expect(service.getSession(created.sessionId)).toBeUndefined();
      expect(service.listSessions('owner')).toEqual([]);
    } finally {
      await service.shutdown();
    }
  });

  it('projects zero availability after an explicit close starts even if cleanup fails', async () => {
    const coordinator = new SessionCoordinator({ now: () => 10_000 });
    const service = new AgentBrowserService({ engine: new FakeEngine(), coordinator });
    try {
      const created = await service.createSession({ tenantId: 'owner' });
      const context = coordinator.captureForCleanup(created.sessionId);
      if (!context) throw new Error('Expected live session');
      vi.spyOn(context.engineSession, 'close').mockRejectedValueOnce(new Error('cleanup failed'));
      await expect(service.closeSession(created.sessionId)).rejects.toThrow();
      expect(service.getSession(created.sessionId)).toMatchObject({
        status: 'engine_crashed',
        closeCause: 'explicit_close',
        leaseRemainingMs: 0,
      });
      expect(service.getSession(created.sessionId)).not.toHaveProperty('lease');
    } finally {
      await service.shutdown();
    }
  });
});

describe('bounded terminal session projection', () => {
  it('adds terminal facts only for the matching independently authenticated tenant', async () => {
    const server = await buildServer({
      engine: new FakeEngine(),
      apiKeys: new Map([
        [createHash('sha256').update('owner-key').digest('hex'), 'owner'],
        [createHash('sha256').update('other-key').digest('hex'), 'other'],
      ]),
    });
    const owner = { authorization: 'Bearer owner-key' };
    try {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: owner,
        payload: { tenantId: 'owner' },
      });
      const { sessionId } = created.json();
      expect(
        (
          await server.inject({
            method: 'DELETE',
            url: `/v1/sessions/${sessionId}`,
            headers: owner,
          })
        ).statusCode
      ).toBe(200);

      const ended = await server.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionId}`,
        headers: owner,
      });
      expect(ended.statusCode).toBe(404);
      expect(ended.json()).toMatchObject({
        error: {
          code: 'SESSION_NOT_FOUND',
          details: {
            sessionTerminal: {
              closeCause: 'explicit_close',
              state: 'closed',
              leaseRemainingMs: 0,
            },
          },
        },
      });

      const denied = await server.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionId}`,
        headers: { authorization: 'Bearer other-key' },
      });
      const missing = await server.inject({
        method: 'GET',
        url: '/v1/sessions/ses_missing',
        headers: { authorization: 'Bearer other-key' },
      });
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toEqual(missing.json());
      expect(denied.body).not.toContain('explicit_close');
      expect(denied.body).not.toContain('sessionTerminal');
    } finally {
      await server.close();
    }
  });

  it('replaces a raced handler failure with a static terminal-only envelope', async () => {
    const engine = new FakeEngine();
    const server = await buildServer({
      engine,
      apiKeys: new Map([[createHash('sha256').update('owner-key').digest('hex'), 'owner']]),
    });
    const owner = { authorization: 'Bearer owner-key' };
    const release = Promise.withResolvers<void>();
    try {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: owner,
        payload: { tenantId: 'owner' },
      });
      const sessionId = created.json().sessionId as string;
      const page = await server.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/pages`,
        headers: owner,
      });
      const raw = engine.getFakePage(engine.getSessionIds()[0] as string, page.json().pageId);
      if (!raw) throw new Error('Expected fake page');
      const entered = Promise.withResolvers<void>();
      vi.spyOn(raw, 'observe').mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        throw new EngineError('SESSION_NOT_FOUND', 'private late message', false, {
          privateReason: 'secret-late-detail',
        });
      });

      const pending = server.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/pages/${page.json().pageId}/observe`,
        headers: owner,
        payload: {},
      });
      await entered.promise;
      expect(
        (
          await server.inject({
            method: 'DELETE',
            url: `/v1/sessions/${sessionId}`,
            headers: owner,
          })
        ).statusCode
      ).toBe(200);
      release.resolve();
      const raced = await pending;
      expect(raced.statusCode).toBe(404);
      expect(raced.json().error).toMatchObject({
        code: 'SESSION_NOT_FOUND',
        message: 'Session does not exist.',
        retryable: false,
        details: { sessionTerminal: { closeCause: 'explicit_close', state: 'closed' } },
      });
      expect(Object.keys(raced.json().error.details)).toEqual(['sessionTerminal']);
      expect(raced.body).not.toContain('private late message');
      expect(raced.body).not.toContain('secret-late-detail');
    } finally {
      release.resolve();
      await server.close();
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
