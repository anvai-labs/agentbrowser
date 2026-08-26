/**
 * TDD Tests for AgentBrowser REST API Server
 *
 * These tests define the expected behavior of the Fastify REST API.
 * Following TDD principles, tests are written before implementation.
 */

import { FakeEngine } from '@agentbrowser/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server';

describe('AgentBrowser REST API', () => {
  let server: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    server = await buildServer();
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterAll(async () => {
    await server.close();
  });

  describe('health check', () => {
    it('should expose liveness at /health/live', async () => {
      const response = await fetch(`${baseUrl}/health/live`);
      expect(response.status).toBe(200);
      expect((await response.json()).status).toBe('live');
    });

    it('should expose readiness at /health/ready', async () => {
      const response = await fetch(`${baseUrl}/health/ready`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe('ready');
      expect(body.engine).toEqual(expect.any(String));
    });

    it('should expose Prometheus metrics at /metrics', async () => {
      // Generate some traffic first.
      const sessionResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: 'metrics' }),
      });
      const { sessionId } = await sessionResponse.json();
      await fetch(`${baseUrl}/sessions/${sessionId}/pages`, { method: 'POST' });

      const response = await fetch(`${baseUrl}/metrics`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');
      const body = await response.text();
      expect(body).toContain('# TYPE operations_total counter');
      expect(body).toContain('operation="session.create"');
      expect(body).toContain('sessions_active');
    });

    it('should return health status', async () => {
      const response = await fetch(`${baseUrl}/health`);

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toMatchObject({
        status: 'healthy',
        version: expect.any(String),
        uptime: expect.any(Number),
      });
    });
  });

  describe('session management', () => {
    it('should create a new session', async () => {
      const response = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'tenant_1',
          options: {
            viewport: { width: 1280, height: 720 },
            locale: 'en-US',
          },
        }),
      });

      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data).toMatchObject({
        sessionId: expect.any(String),
        status: 'ready',
        engine: { name: expect.any(String), version: expect.any(String) },
        createdAt: expect.any(String),
        ttlMs: expect.any(Number),
        idleTimeoutMs: expect.any(Number),
      });
    });

    it('should get session by ID', async () => {
      // First create a session
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'tenant_1',
        }),
      });

      const { sessionId } = await createResponse.json();

      // Then get it
      const response = await fetch(`${baseUrl}/sessions/${sessionId}`);

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.sessionId).toBe(sessionId);
      expect(data.status).toMatch(/ready|active/);
    });

    it('should list all sessions', async () => {
      const response = await fetch(`${baseUrl}/sessions`);

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toHaveProperty('sessions');
      expect(Array.isArray(data.sessions)).toBe(true);
      expect(data.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: expect.any(String),
            status: expect.any(String),
          }),
        ])
      );
    });

    it('should close a session', async () => {
      // First create a session
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'tenant_1',
        }),
      });

      const { sessionId } = await createResponse.json();

      // Then close it
      const response = await fetch(`${baseUrl}/sessions/${sessionId}`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toMatchObject({
        sessionId,
        status: 'closed',
      });
    });
  });

  describe('page management', () => {
    let sessionId: string;

    beforeEach(async () => {
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'tenant_1',
        }),
      });

      const { sessionId: id } = await createResponse.json();
      sessionId = id;
    });

    it('should create a new page', async () => {
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages`, {
        method: 'POST',
      });

      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data).toMatchObject({
        pageId: expect.any(String),
        sessionId,
        status: 'ready',
      });
    });

    it('should get page by ID', async () => {
      // First create a page
      const createResponse = await fetch(`${baseUrl}/sessions/${sessionId}/pages`, {
        method: 'POST',
      });

      const { pageId } = await createResponse.json();

      // Then get it
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}`);

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.pageId).toBe(pageId);
      expect(data.sessionId).toBe(sessionId);
    });

    it('should close a page', async () => {
      // First create a page
      const createResponse = await fetch(`${baseUrl}/sessions/${sessionId}/pages`, {
        method: 'POST',
      });

      const { pageId } = await createResponse.json();

      // Then close it
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toMatchObject({
        pageId,
        status: 'closed',
      });
    });
  });

  describe('navigation', () => {
    let sessionId: string;
    let pageId: string;

    beforeEach(async () => {
      // Create session
      const sessionResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'tenant_1',
        }),
      });

      const { sessionId: id } = await sessionResponse.json();
      sessionId = id;

      // Create page
      const pageResponse = await fetch(`${baseUrl}/sessions/${sessionId}/pages`, {
        method: 'POST',
      });

      const { pageId: pid } = await pageResponse.json();
      pageId = pid;
    });

    it('should navigate to URL', async () => {
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          waitUntil: 'load',
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toMatchObject({
        status: 'success',
        url: expect.any(String),
        redirectChain: expect.any(Array),
      });
    });

    it('should validate URL format', async () => {
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'not-a-valid-url',
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toMatchObject({
        code: 'INVALID_REQUEST',
        message: expect.stringContaining('URL'),
      });
    });
  });

  describe('observations', () => {
    let sessionId: string;
    let pageId: string;

    beforeEach(async () => {
      // Create session and page
      const sessionResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'tenant_1',
        }),
      });

      const { sessionId: id } = await sessionResponse.json();
      sessionId = id;

      const pageResponse = await fetch(`${baseUrl}/sessions/${sessionId}/pages`, {
        method: 'POST',
      });

      const { pageId: pid } = await pageResponse.json();
      pageId = pid;

      // Navigate first
      await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
        }),
      });
    });

    it('should get semantic observation', async () => {
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/observe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'interactive',
          maxElements: 300,
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toMatchObject({
        sessionId,
        pageId,
        revision: expect.any(Number),
        url: expect.any(String),
        title: expect.any(String),
        status: expect.any(String),
        elements: expect.any(Array),
        truncated: expect.any(Boolean),
      });
    });

    it('should support different observation modes', async () => {
      const modes = ['interactive', 'content', 'accessibility'];

      for (const mode of modes) {
        const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/observe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode,
          }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data).toHaveProperty('elements');
      }
    });
  });

  describe('action execution', () => {
    let sessionId: string;
    let pageId: string;

    beforeEach(async () => {
      // Create session and page
      const sessionResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'tenant_1',
        }),
      });

      const { sessionId: id } = await sessionResponse.json();
      sessionId = id;

      const pageResponse = await fetch(`${baseUrl}/sessions/${sessionId}/pages`, {
        method: 'POST',
      });

      const { pageId: pid } = await pageResponse.json();
      pageId = pid;

      // Navigate first
      await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
        }),
      });
    });

    it('should execute click action', async () => {
      // First get an observation to find element refs
      const obsResponse = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/observe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'interactive',
        }),
      });

      const { elements } = await obsResponse.json();
      if (elements.length === 0) {
        // Skip if no elements found
        return;
      }

      const targetRef = elements[0]?.ref;
      if (!targetRef) throw new Error('no elements observed');

      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { ref: targetRef },
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toMatchObject({
        status: 'success',
        actionId: expect.any(String),
        newRevision: expect.any(Number),
      });
    });

    it('should execute fill action', async () => {
      // First get an observation to find textbox refs
      const obsResponse = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/observe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'interactive',
        }),
      });

      const { elements } = await obsResponse.json();
      const textbox = elements.find((el: any) => el.role === 'textbox');

      if (!textbox) {
        // Skip if no textbox found
        return;
      }

      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'fill',
          target: { ref: textbox.ref },
          value: 'test@example.com',
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('success');
    });

    it('should handle a stale target error', async () => {
      // Observe to mint refs, move the page on, then act on the old ref.
      const observeResponse = await fetch(
        `${baseUrl}/sessions/${sessionId}/pages/${pageId}/observe`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'interactive' }),
        }
      );
      const observation = await observeResponse.json();
      const oldRef = observation.elements[0]?.ref;
      if (!oldRef) throw new Error('no elements observed');

      await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'press', key: 'Enter' }),
      });

      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { ref: oldRef },
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toMatchObject({
        code: 'STALE_TARGET',
        message: expect.any(String),
        retryable: true,
      });
    });

    it('should require an observation before acting', async () => {
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { ref: 'e1_0' },
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe('INVALID_REQUEST');
      expect(data.error.message).toMatch(/observe/i);
    });
  });

  describe('screenshots', () => {
    let sessionId: string;
    let pageId: string;

    beforeEach(async () => {
      const sessionResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: 'tenant_1' }),
      });
      const { sessionId: id } = await sessionResponse.json();
      sessionId = id;

      const pageResponse = await fetch(`${baseUrl}/sessions/${sessionId}/pages`, {
        method: 'POST',
      });
      const { pageId: pid } = await pageResponse.json();
      pageId = pid;
    });

    it('should capture a screenshot artifact', async () => {
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullPage: true, format: 'png' }),
      });

      expect(response.status).toBe(200);
      const artifact = await response.json();
      expect(artifact.artifactId).toEqual(expect.any(String));
      expect(artifact.type).toBe('screenshot');
      expect(artifact.contentType).toBe('image/png');
      expect(artifact.sizeBytes).toBeGreaterThan(0);
      expect(artifact.url).toEqual(expect.any(String));
    });

    it('should honour the requested format', async () => {
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'jpeg' }),
      });

      const artifact = await response.json();
      expect(artifact.contentType).toBe('image/jpeg');
    });

    it('should reject an unsupported format', async () => {
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'bmp' }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('should return 404 for an unknown page', async () => {
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/pg_missing/screenshot`, {
        method: 'POST',
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('error handling', () => {
    it('should return 404 for non-existent session', async () => {
      const response = await fetch(`${baseUrl}/sessions/nonexistent`);

      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.error).toMatchObject({
        code: 'SESSION_NOT_FOUND',
        message: expect.any(String),
      });
    });

    it('should return 400 for invalid request body', async () => {
      const response = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toMatchObject({
        code: 'INVALID_REQUEST',
        message: expect.any(String),
      });
    });

    it('should return proper error codes', async () => {
      const errorTests = [
        { endpoint: '/sessions/nonexistent', expectedCode: 'NOT_FOUND' },
        { endpoint: '/sessions/invalid-page-id/pages', expectedCode: 'NOT_FOUND' },
      ];

      for (const { endpoint, expectedCode } of errorTests) {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          method: endpoint.includes('pages') ? 'POST' : 'GET',
        });

        if (response.status !== 200) {
          const data = await response.json();
          expect(data.error?.code).toMatch(expectedCode);
        }
      }
    });
  });

  describe('CORS and security', () => {
    it('should handle CORS preflight requests', async () => {
      const response = await fetch(`${baseUrl}/sessions`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://example.test',
          'Access-Control-Request-Method': 'POST',
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBeDefined();
      expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    });

    it('should reject an OPTIONS request that is not a valid preflight', async () => {
      // No Origin / Access-Control-Request-Method: not a preflight at all.
      const response = await fetch(`${baseUrl}/sessions`, { method: 'OPTIONS' });

      expect(response.status).toBe(400);
    });

    it('should include security headers', async () => {
      const response = await fetch(`${baseUrl}/health`);

      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });
  });
});

describe('AgentBrowser REST API safety integration', () => {
  let server: FastifyInstance;
  let baseUrl: string;
  let engine: FakeEngine;

  beforeAll(async () => {
    engine = new FakeEngine();
    server = await buildServer({ engine });
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterAll(async () => {
    await server.close();
  });

  const setupPage = async () => {
    const sessionResponse = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant_1' }),
    });
    const { sessionId } = await sessionResponse.json();

    const pageResponse = await fetch(`${baseUrl}/sessions/${sessionId}/pages`, {
      method: 'POST',
    });
    const { pageId } = await pageResponse.json();

    return { sessionId, pageId };
  };

  describe('network egress policy at the HTTP layer', () => {
    it('should 403 POLICY_DENIED for loopback navigation', async () => {
      const { sessionId, pageId } = await setupPage();

      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://localhost/admin' }),
      });

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.code).toBe('POLICY_DENIED');
    });

    it('should 403 POLICY_DENIED for cloud metadata navigation', async () => {
      const { sessionId, pageId } = await setupPage();

      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data' }),
      });

      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('POLICY_DENIED');
    });

    it('should 403 POLICY_DENIED for a file: URL and 400 for a malformed one', async () => {
      const { sessionId, pageId } = await setupPage();

      const fileResponse = await fetch(
        `${baseUrl}/sessions/${sessionId}/pages/${pageId}/navigate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'file:///etc/passwd' }),
        }
      );
      expect(fileResponse.status).toBe(403);
      expect((await fileResponse.json()).error.code).toBe('POLICY_DENIED');

      const malformedResponse = await fetch(
        `${baseUrl}/sessions/${sessionId}/pages/${pageId}/navigate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'not-a-valid-url' }),
        }
      );
      expect(malformedResponse.status).toBe(400);
      expect((await malformedResponse.json()).error.code).toBe('INVALID_REQUEST');
    });
  });

  describe('approval gate at the HTTP layer', () => {
    it('should 403 APPROVAL_REQUIRED for a high-risk element, then accept the token', async () => {
      const { sessionId, pageId } = await setupPage();

      await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://shop.example.com' }),
      });

      // Inject an element classified as a transaction risk.
      const engineSessionIds = engine.getSessionIds();
      const enginePage = engineSessionIds[engineSessionIds.length - 1]
        ? engine.getFakePage(engineSessionIds[engineSessionIds.length - 1]!, pageId)
        : undefined;
      enginePage?.setElements([{ role: 'button', name: 'Pay now', risk: 'transaction' }]);

      const observeResponse = await fetch(
        `${baseUrl}/sessions/${sessionId}/pages/${pageId}/observe`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'interactive' }),
        }
      );
      const observation = await observeResponse.json();
      const ref = observation.elements[0]?.ref;
      if (!ref) throw new Error('no elements observed');

      const denied = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'click', target: { ref } }),
      });

      expect(denied.status).toBe(403);
      const denial = await denied.json();
      expect(denial.error.code).toBe('APPROVAL_REQUIRED');
      expect(denial.error.details.tokenId).toEqual(expect.any(String));

      const approved = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { ref },
          approvalToken: denial.error.details.tokenId,
        }),
      });

      expect(approved.status).toBe(200);
      const result = await approved.json();
      expect(result.status).toBe('success');
    });
  });

  describe('extraction over HTTP', () => {
    it('should extract markdown from a real page state', async () => {
      const { sessionId, pageId } = await setupPage();

      await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'text' }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.data.text).toEqual(expect.any(String));
      expect(result.evidence[0]).toMatchObject({
        url: 'https://example.com',
        revision: expect.any(Number),
      });
      expect(typeof result.evidence[0].hash).toBe('string');
    });

    it('should reject an unknown format', async () => {
      const { sessionId, pageId } = await setupPage();

      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'yaml' }),
      });

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_REQUEST');
    });
  });

  describe('diffs and continuation over HTTP', () => {
    it('should return element changes for sinceRevision', async () => {
      const { sessionId, pageId } = await setupPage();

      await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      const before = await (
        await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/observe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
      ).json();

      // Move the page on with a fill so there is something to diff.
      const textbox = before.elements.find((e: any) => e.role === 'textbox');
      await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'fill',
          target: { ref: textbox.ref },
          value: 'diffed@example.com',
        }),
      });

      const diffResponse = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/observe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sinceRevision: before.revision }),
      });

      expect(diffResponse.status).toBe(200);
      const diff = await diffResponse.json();
      expect(diff.changes.some((c: any) => c.change === 'modified')).toBe(true);
      expect(diff.revision).toBeGreaterThan(before.revision);
    });

    it('should paginate observations with a continuation cursor', async () => {
      const { sessionId, pageId } = await setupPage();

      await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      const firstResponse = await fetch(
        `${baseUrl}/sessions/${sessionId}/pages/${pageId}/observe`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxElements: 2 }),
        }
      );
      const first = await firstResponse.json();

      expect(first.elements).toHaveLength(2);
      expect(first.truncated).toBe(true);
      expect(first.continuation).toEqual({ nextOrdinal: 2, remaining: 3 });

      const secondResponse = await fetch(
        `${baseUrl}/sessions/${sessionId}/pages/${pageId}/observe`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxElements: 2, continueFrom: first.continuation.nextOrdinal }),
        }
      );
      const second = await secondResponse.json();

      expect(second.elements).toHaveLength(2);
      const firstRefs = first.elements.map((e: any) => e.ref);
      for (const element of second.elements) {
        expect(firstRefs).not.toContain(element.ref);
      }
    });
  });

  describe('downloads and artifacts over HTTP', () => {
    // Downloads run against an injected fetcher so tests never touch the
    // network.
    let previous: { server: FastifyInstance; baseUrl: string };

    beforeAll(async () => {
      // Capture the outer suite's live server now, not at registration time.
      previous = { server, baseUrl };
      engine = new FakeEngine();
      server = await buildServer({
        engine,
        downloader: async () => ({
          bytes: new Uint8Array([104, 101, 108, 108, 111]), // "hello"
          contentType: 'text/csv',
        }),
      });
      baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
    });

    afterAll(async () => {
      await server.close();
      // The outer suite's server stayed listening throughout.
      server = previous.server;
      baseUrl = previous.baseUrl;
    });

    it('should refuse downloads for a session that does not allow them', async () => {
      const { sessionId, pageId } = await setupPage();

      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://files.example.com/report.csv' }),
      });

      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('DOWNLOAD_BLOCKED');
    });

    it('should download, store and serve an artifact when allowed', async () => {
      const sessionResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: 'dl', allowDownloads: true }),
      });
      const { sessionId } = await sessionResponse.json();
      const pageId = (
        await (await fetch(`${baseUrl}/sessions/${sessionId}/pages`, { method: 'POST' })).json()
      ).pageId;

      const downloadResponse = await fetch(
        `${baseUrl}/sessions/${sessionId}/pages/${pageId}/download`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: 'https://files.example.com/report.csv',
            filename: 'report.csv',
          }),
        }
      );

      expect(downloadResponse.status).toBe(200);
      const artifact = await downloadResponse.json();
      expect(artifact.type).toBe('download');
      expect(artifact.filename).toBe('report.csv');

      const storedResponse = await fetch(
        `${baseUrl}/sessions/${sessionId}/artifacts/${artifact.artifactId}`
      );
      expect(storedResponse.status).toBe(200);
      const stored = await storedResponse.json();
      expect(stored.metadata.artifactId).toBe(artifact.artifactId);
      expect(Buffer.from(stored.contentBase64, 'base64').toString('utf8')).toBe('hello');

      // Cross-session and unknown artifacts are 404.
      const missing = await fetch(`${baseUrl}/sessions/${sessionId}/artifacts/art_missing`);
      expect(missing.status).toBe(404);
    });

    it('should 404 artifacts from another session', async () => {
      const sessionResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: 'dl-a', allowDownloads: true }),
      });
      const a = (await sessionResponse.json()).sessionId;
      const pageId = (
        await (await fetch(`${baseUrl}/sessions/${a}/pages`, { method: 'POST' })).json()
      ).pageId;

      const artifact = await (
        await fetch(`${baseUrl}/sessions/${a}/pages/${pageId}/download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://files.example.com/a.csv' }),
        })
      ).json();

      const other = (
        await (
          await fetch(`${baseUrl}/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenantId: 'dl-b' }),
          })
        ).json()
      ).sessionId;

      const cross = await fetch(`${baseUrl}/sessions/${other}/artifacts/${artifact.artifactId}`);
      expect(cross.status).toBe(404);
    });
  });

  describe('real observations over FakeEngine', () => {
    it('should return engine-derived elements with normalized refs', async () => {
      const { sessionId, pageId } = await setupPage();

      await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/observe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'interactive' }),
      });

      expect(response.status).toBe(200);
      const observation = await response.json();
      expect(observation.url).toBe('https://example.com');
      expect(observation.revision).toBeGreaterThan(0);
      expect(observation.elements.length).toBeGreaterThan(0);
      for (const element of observation.elements) {
        expect(element.ref).toMatch(/^e\d+_\d+$/);
      }
      expect(observation.untrustedContent).toBe(true);
    });

    it('should act on an observed ref and report the new revision', async () => {
      const { sessionId, pageId } = await setupPage();

      await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      const observeResponse = await fetch(
        `${baseUrl}/sessions/${sessionId}/pages/${pageId}/observe`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      const observation = await observeResponse.json();

      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { ref: observation.elements[0]?.ref ?? 'e0_0' },
        }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.status).toBe('success');
      expect(result.actionId).toEqual(expect.any(String));
      expect(result.newRevision).toBeGreaterThan(observation.revision);
    });
  });
});
