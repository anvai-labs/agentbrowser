/**
 * TDD Tests for AgentBrowser REST API Server
 *
 * These tests define the expected behavior of the Fastify REST API.
 * Following TDD principles, tests are written before implementation.
 */

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
        metadata: {
          createdAt: expect.any(String),
          expiresAt: expect.any(String),
        },
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

      const targetRef = elements[0].ref;

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

    it('should handle stale target error', async () => {
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/pages/${pageId}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { ref: 'e999_0' }, // Invalid ref
        }),
      });

      expect(response.status).toBe(400); // or 409 for conflict

      const data = await response.json();
      expect(data.error).toMatchObject({
        code: expect.stringMatching(/STALE_TARGET|TARGET_NOT_FOUND/),
        message: expect.any(String),
        retryable: expect.any(Boolean),
      });
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
        code: 'NOT_FOUND',
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
