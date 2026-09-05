import { createHash } from 'node:crypto';
import { InMemoryTracer, SecretManager } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { AgentBrowserService } from './service.js';

describe('evidence boundaries', () => {
  it('scrubs untrusted dictionary keys, navigation results and policy span metadata', async () => {
    const secrets = new SecretManager({ 'vault://test': 'hunter2' });
    const tracer = new InMemoryTracer();
    const engine = new FakeEngine();
    const service = new AgentBrowserService({ engine, secretManager: secrets, tracer });
    try {
      const { sessionId } = await service.createSession({ tenantId: 'local' });
      const { pageId } = await service.createPage(sessionId);
      const navigated = await service.navigate(sessionId, pageId, {
        url: 'https://hunter2.example.com/hunter2',
      });
      expect(JSON.stringify(navigated)).not.toContain('hunter2');
      expect(JSON.stringify(tracer.completedSpans())).not.toContain('hunter2');
      const engineId = engine.getSessionIds()[0];
      const page = engineId ? engine.getFakePage(engineId, pageId) : undefined;
      if (!page) throw new Error('Missing fake page');
      page.setContent(
        '<script type="application/ld+json">{"hunter2":1,"***":2,"nested":{"hunter2":3}}</script>'
      );
      const extracted = await service.extract(sessionId, pageId, { format: 'jsonld' });
      expect(JSON.stringify(extracted)).not.toContain('hunter2');
      expect(secrets.redactUntrusted({ hunter2: 1, '***': 2 })).toEqual({ '***': 1, '***#1': 2 });
      page.emitEvent('console', { hunter2: 'safe' });
      await expect.poll(() => service.getSessionEvents(sessionId, 'console').length).toBe(1);
      expect(JSON.stringify(service.getSessionEvents(sessionId, 'console'))).not.toContain(
        'hunter2'
      );
    } finally {
      await service.shutdown();
    }
  });
  it('retains owner checks through session expiry and expires artifacts independently', async () => {
    const clock = vi.spyOn(Date, 'now');
    const start = clock.getMockImplementation()?.() ?? Date.now();
    clock.mockReturnValue(start);
    const service = new AgentBrowserService({ engine: new FakeEngine() });
    try {
      const { sessionId } = await service.createSession({ tenantId: 'alice', ttlMs: 1000 });
      const { pageId } = await service.createPage(sessionId);
      const artifact = await service.screenshot(sessionId, pageId, {});
      clock.mockReturnValue(start + 1001);
      expect(service.getSession(sessionId)).toBeUndefined();
      expect(() => service.getArtifact(sessionId, artifact.artifactId, 'bob')).toThrow(
        /another tenant/
      );
      expect(service.getArtifact(sessionId, artifact.artifactId, 'alice')).toBeDefined();
      await expect(service.exportTrace(sessionId)).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      });
      clock.mockReturnValue(start + 16 * 60_000);
      expect(service.getArtifact(sessionId, artifact.artifactId, 'alice')).toBeUndefined();
    } finally {
      await service.shutdown();
      clock.mockRestore();
    }
  });

  it('injects the configured secret registry through the HTTP composition root', async () => {
    const engine = new FakeEngine();
    const server = await buildServer({
      engine,
      secretManager: new SecretManager({ 'vault://p': 'hunter2' }),
    });
    try {
      const { sessionId } = (
        await server.inject({ method: 'POST', url: '/v1/sessions', payload: { tenantId: 'local' } })
      ).json();
      const { pageId } = (
        await server.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/pages` })
      ).json();
      engine.getFakePage(engine.getSessionIds()[0]!, pageId)!.setContent('<p>hunter2</p>');
      const result = await server.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/pages/${pageId}/extract`,
        payload: { format: 'text' },
      });
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('***');
      expect(result.body).not.toContain('hunter2');
    } finally {
      await server.close();
    }
  });
  it('retains artifact ownership after close, filters lists, and rejects new evidence for closed sessions', async () => {
    const server = await buildServer({
      engine: new FakeEngine(),
      apiKeys: new Map(
        ['alice', 'bob'].map((key) => [createHash('sha256').update(key).digest('hex'), key])
      ),
    });
    const alice = { authorization: 'Bearer alice' };
    const bob = { authorization: 'Bearer bob' };
    try {
      const session = (
        await server.inject({ method: 'POST', url: '/v1/sessions', headers: alice, payload: {} })
      ).json();
      const base = `/v1/sessions/${session.sessionId}`;
      const page = (
        await server.inject({ method: 'POST', url: `${base}/pages`, headers: alice })
      ).json();
      const captured = await server.inject({
        method: 'POST',
        url: `${base}/pages/${page.pageId}/screenshot`,
        headers: alice,
        payload: {},
      });
      expect(captured.statusCode).toBe(200);
      const artifact = `${base}/artifacts/${captured.json().artifactId}`;
      expect((await server.inject({ url: artifact, headers: bob })).statusCode).toBe(403);
      expect((await server.inject({ url: '/v1/sessions', headers: bob })).json().sessions).toEqual(
        []
      );
      expect(
        (await server.inject({ method: 'DELETE', url: base, headers: alice })).statusCode
      ).toBe(200);
      expect((await server.inject({ url: artifact, headers: bob })).statusCode).toBe(403);
      expect((await server.inject({ url: artifact, headers: alice })).statusCode).toBe(200);
      expect(
        (await server.inject({ method: 'POST', url: `${base}/trace`, headers: alice })).statusCode
      ).toBe(404);
      expect((await server.inject({ url: `${base}/events`, headers: alice })).statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('scrubs events before replay and delivery, and deterministic extraction including evidence', async () => {
    const engine = new FakeEngine();
    const service = new AgentBrowserService({
      engine,
      secretManager: new SecretManager({ 'vault://test': 'sensitive-value' }),
    });
    try {
      const { sessionId } = await service.createSession({ tenantId: 'alice' });
      const { pageId } = await service.createPage(sessionId);
      const page = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
      page.setContent('<p>sensitive-value</p>');
      const delivered: unknown[] = [];
      const unsubscribe = service.subscribe(sessionId, (event) => delivered.push(event));
      page.emitEvent('console', { text: 'sensitive-value' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(delivered.length).toBeGreaterThan(0);
      expect(JSON.stringify(delivered)).not.toContain('sensitive-value');
      expect(JSON.stringify(service.getSessionEvents(sessionId))).not.toContain('sensitive-value');
      const extraction = await service.extract(sessionId, pageId, { format: 'text' });
      expect(JSON.stringify(extraction)).toContain('***');
      expect(JSON.stringify(extraction)).not.toContain('sensitive-value');
      unsubscribe?.();
    } finally {
      await service.shutdown();
    }
  });
});
