import { createServer } from 'node:http';
import {
  ArtifactStore,
  SessionCoordinator,
  SessionState,
  StructuredLogger,
} from '@agentbrowser/core';
import { NetworkPolicy } from '@agentbrowser/policy';
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

describe('session-owned downloads', () => {
  it('keeps navigation and downloads on the same old-versus-new policy generation', async () => {
    const base = new NetworkPolicy();
    const service = new AgentBrowserService({
      engine: new FakeEngine(),
      networkPolicy: base,
      downloader: async () => ({ bytes: new Uint8Array([1]), contentType: 'text/plain' }),
      sweepIntervalMs: 0,
    });
    try {
      const old = await service.createSession({ allowDownloads: true });
      const oldPage = await service.createPage(old.sessionId);
      base.updateConfig({ blockLoopback: true });
      const next = await service.createSession({ allowDownloads: true });
      const nextPage = await service.createPage(next.sessionId);
      await service.navigate(old.sessionId, oldPage.pageId, { url: 'http://127.0.0.1' });
      await service.download(old.sessionId, oldPage.pageId, { url: 'http://127.0.0.1' });
      await expect(
        service.navigate(next.sessionId, nextPage.pageId, { url: 'http://127.0.0.1' })
      ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await expect(
        service.download(next.sessionId, nextPage.pageId, { url: 'http://127.0.0.1' })
      ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    } finally {
      await service.shutdown();
    }
  });

  it('requires explicit snapshots only for custom policies opting into downloads', async () => {
    class CustomPolicy extends NetworkPolicy {
      override async checkRequest() {
        throw new Error('custom deny');
      }
    }
    const service = new AgentBrowserService({
      engine: new FakeEngine(),
      networkPolicy: new CustomPolicy(),
      sweepIntervalMs: 0,
    });
    try {
      await service.createSession({});
      await expect(service.createSession({ allowDownloads: true })).rejects.toMatchObject({
        code: 'ENGINE_UNSUPPORTED',
      });
    } finally {
      await service.shutdown();
    }
  });
  it.each(['close', 'failed-close', 'expire', 'crash', 'shutdown'])(
    'interrupts a real stalled body before engine teardown on %s',
    async (mode) => {
      let entered!: () => void;
      const contact = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const server = createServer((_request, response) => {
        response.writeHead(200);
        response.flushHeaders();
        entered();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const coordinator = new SessionCoordinator({ cleanupCheckIntervalMs: 3_600_000 });
      const artifacts = new ArtifactStore();
      const put = vi.spyOn(artifacts, 'put');
      const logs: string[] = [];
      const service = new AgentBrowserService({
        engine: new FakeEngine(),
        coordinator,
        artifactStore: artifacts,
        networkPolicy: new NetworkPolicy(),
        logger: new StructuredLogger({ sink: (line) => logs.push(line) }),
        sweepIntervalMs: 0,
      });
      let finish!: () => void;
      const stalled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let closing: Promise<void> | undefined;
      let restoreClose = () => {};
      try {
        const { sessionId } = await service.createSession({ allowDownloads: true });
        const { pageId } = await service.createPage(sessionId);
        const context = coordinator.get(sessionId);
        if (!context) throw new Error('Missing session context');
        const originalClose = context.engineSession.close.bind(context.engineSession);
        const closeSpy = vi.spyOn(context.engineSession, 'close').mockImplementation(async () => {
          await stalled;
          await originalClose();
          if (mode === 'failed-close') throw new Error('engine teardown failure');
        });
        restoreClose = () => closeSpy.mockRestore();
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing address');
        const result = service.download(sessionId, pageId, {
          url: `http://127.0.0.1:${address.port}/?secret=not-for-logs`,
        });
        const rejected = expect(result).rejects.toMatchObject({
          code:
            mode === 'expire'
              ? 'SESSION_EXPIRED'
              : mode === 'crash'
                ? 'ENGINE_CRASHED'
                : 'SESSION_NOT_FOUND',
        });
        await contact;
        if (mode === 'expire') {
          context.metadata.expiresAt = 0;
          expect(coordinator.get(sessionId)).toBeUndefined();
        } else if (mode === 'crash')
          closing = coordinator.terminate(sessionId, SessionState.ENGINE_CRASHED, 'fixture');
        else if (mode === 'shutdown') closing = service.shutdown();
        else closing = service.closeSession(sessionId).catch(() => {});
        await rejected; // Must not depend on finish() or fixture cleanup.
        expect(put).not.toHaveBeenCalled();
        const outcomes = logs
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.message === 'download.transport');
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]).toMatchObject({
          outcome: 'error',
          generation: expect.any(String),
          connectionId: expect.any(String),
        });
        expect(logs.join('')).not.toContain('not-for-logs');
        await expect(
          service.download(sessionId, pageId, { url: `http://127.0.0.1:${address.port}` })
        ).rejects.toBeDefined();
      } finally {
        finish();
        await closing;
        restoreClose();
        await service.shutdown();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );

  it('never stores a late test-fetcher result after its owner closes', async () => {
    let finish!: (value: { bytes: Uint8Array; contentType: string }) => void;
    let entered!: () => void;
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<{ bytes: Uint8Array; contentType: string }>((resolve) => {
      finish = resolve;
    });
    const artifacts = new ArtifactStore();
    const put = vi.spyOn(artifacts, 'put');
    const service = new AgentBrowserService({
      engine: new FakeEngine(),
      artifactStore: artifacts,
      downloader: async () => {
        entered();
        return pending;
      },
      sweepIntervalMs: 0,
    });
    try {
      const { sessionId } = await service.createSession({ allowDownloads: true });
      const { pageId } = await service.createPage(sessionId);
      const result = service.download(sessionId, pageId, { url: 'https://download.invalid' });
      const rejected = expect(result).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
      await called;
      await service.closeSession(sessionId);
      await rejected;
      finish({ bytes: new Uint8Array([1]), contentType: 'text/plain' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(put).not.toHaveBeenCalled();
    } finally {
      finish({ bytes: new Uint8Array(), contentType: 'text/plain' });
      await service.shutdown();
    }
  });

  it('snapshots input policy before engine creation and shares it with downloads', async () => {
    const engine = new FakeEngine();
    const create = engine.createSession.bind(engine);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(engine, 'createSession').mockImplementation(async (options) => {
      await pending;
      return create(options);
    });
    const base = new NetworkPolicy({ blockLoopback: true });
    const fetch = vi.fn(async () => ({ bytes: new Uint8Array([1]), contentType: 'text/plain' }));
    const service = new AgentBrowserService({
      engine,
      networkPolicy: base,
      downloader: fetch,
      sweepIntervalMs: 0,
    });
    try {
      const request = { allowDownloads: true, allowedHosts: ['download.invalid'] };
      const creating = service.createSession(request);
      request.allowedHosts.push('127.0.0.1');
      request.allowDownloads = false;
      base.updateConfig({ blockLoopback: false });
      finish();
      const { sessionId } = await creating;
      const { pageId } = await service.createPage(sessionId);
      await expect(
        service.download(sessionId, pageId, { url: 'http://127.0.0.1' })
      ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await service.download(sessionId, pageId, { url: 'https://download.invalid' });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      await service.shutdown();
    }
  });

  it('does not publish a new transport when engine creation finishes after shutdown', async () => {
    const engine = new FakeEngine();
    const create = engine.createSession.bind(engine);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(engine, 'createSession').mockImplementation(async (options) => {
      await pending;
      return create(options);
    });
    const coordinator = new SessionCoordinator();
    const service = new AgentBrowserService({ engine, coordinator, sweepIntervalMs: 0 });
    const creating = service.createSession({ allowDownloads: true });
    const rejected = expect(creating).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    try {
      await service.shutdown();
      finish();
      await rejected;
      expect(coordinator.getSessionCount()).toBe(0);
    } finally {
      finish();
      await service.shutdown();
    }
  });
});
