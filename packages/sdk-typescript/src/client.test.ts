/**
 * AgentBrowser SDK Client Tests
 *
 * Following TDD principles, these tests define the expected behavior
 * of the TypeScript SDK client.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowserClient } from './client';

// Mock fetch globally
global.fetch = vi.fn() as any;

describe('AgentBrowser SDK', () => {
  let client: AgentBrowserClient;
  let mockFetch: any;

  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();
    mockFetch = global.fetch as any;

    client = new AgentBrowserClient({
      baseUrl: 'http://localhost:3000',
    });
  });

  describe('client initialization', () => {
    it('should create client with default options', () => {
      const defaultClient = new AgentBrowserClient();

      expect(defaultClient).toBeDefined();
      expect(defaultClient.baseUrl).toBe('http://localhost:3000');
    });

    it('should create client with custom baseUrl', () => {
      const customClient = new AgentBrowserClient({
        baseUrl: 'https://api.example.com',
      });

      expect(customClient.baseUrl).toBe('https://api.example.com');
    });

    it('should create client with timeout option', () => {
      const clientWithTimeout = new AgentBrowserClient({
        baseUrl: 'http://localhost:3000',
        timeout: 10000,
      });

      expect(clientWithTimeout.timeout).toBe(10000);
    });
  });

  describe('session management', () => {
    it('should create session', async () => {
      const mockSession = {
        sessionId: 'ses_test123',
        status: 'ready',
        engine: {
          name: 'playwright-chromium',
          version: '1.0.0',
          capabilities: {},
        },
        createdAt: '2025-01-23T10:00:00.000Z',
        ttlMs: 900000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => mockSession,
      });

      const session = await client.sessions.create({
        tenantId: 'tenant_1',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/sessions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ tenantId: 'tenant_1' }),
        })
      );

      expect(session.sessionId).toBe('ses_test123');
      expect(session.status).toBe('ready');
    });

    it('should get session by ID', async () => {
      const mockSession = {
        sessionId: 'ses_test123',
        status: 'ready',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockSession,
      });

      const session = await client.sessions.get('ses_test123');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/sessions/ses_test123',
        expect.objectContaining({
          method: 'GET',
        })
      );

      expect(session.sessionId).toBe('ses_test123');
    });

    it('should list all sessions', async () => {
      const mockResponse = {
        sessions: [
          { sessionId: 'ses_1', status: 'ready' },
          { sessionId: 'ses_2', status: 'active' },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const sessions = await client.sessions.list();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/sessions',
        expect.objectContaining({
          method: 'GET',
        })
      );

      expect(sessions).toHaveLength(2);
      expect(sessions[0].sessionId).toBe('ses_1');
    });

    it('should close session', async () => {
      const mockResponse = {
        sessionId: 'ses_test123',
        status: 'closed',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      await client.sessions.close('ses_test123');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/sessions/ses_test123',
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });

    it('should handle session creation errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 'INVALID_REQUEST',
            message: 'Invalid tenant ID',
            retryable: false,
          },
        }),
      });

      await expect(client.sessions.create({ tenantId: '' })).rejects.toThrow(
        'INVALID_REQUEST: Invalid tenant ID'
      );
    });
  });

  describe('page management', () => {
    it('should create page', async () => {
      const mockPage = {
        pageId: 'pg_test123',
        sessionId: 'ses_test123',
        status: 'ready',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => mockPage,
      });

      const page = await client.sessions.createPage('ses_test123');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/sessions/ses_test123/pages',
        expect.objectContaining({
          method: 'POST',
        })
      );

      expect(page.pageId).toBe('pg_test123');
      expect(page.sessionId).toBe('ses_test123');
    });

    it('should get page by ID', async () => {
      const mockPage = {
        pageId: 'pg_test123',
        sessionId: 'ses_test123',
        status: 'ready',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockPage,
      });

      const page = await client.sessions.getPage('ses_test123', 'pg_test123');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/sessions/ses_test123/pages/pg_test123',
        expect.objectContaining({
          method: 'GET',
        })
      );

      expect(page.pageId).toBe('pg_test123');
    });

    it('should close page', async () => {
      const mockResponse = {
        pageId: 'pg_test123',
        sessionId: 'ses_test123',
        status: 'closed',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      await client.sessions.closePage('ses_test123', 'pg_test123');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/sessions/ses_test123/pages/pg_test123',
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });
  });

  describe('navigation', () => {
    it('should navigate to URL', async () => {
      const mockResponse = {
        status: 'success',
        url: 'https://example.com',
        redirectChain: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const result = await client.sessions.navigate('ses_test123', 'pg_test123', {
        url: 'https://example.com',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/sessions/ses_test123/pages/pg_test123/navigate',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ url: 'https://example.com' }),
        })
      );

      expect(result.url).toBe('https://example.com');
      expect(result.status).toBe('success');
    });

    it('should validate URL format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 'INVALID_REQUEST',
            message: 'Invalid URL format',
            retryable: false,
          },
        }),
      });

      await expect(
        client.sessions.navigate('ses_test123', 'pg_test123', {
          url: 'not-a-url',
        })
      ).rejects.toThrow('INVALID_REQUEST: Invalid URL format');
    });
  });

  describe('observations', () => {
    it('should get semantic observation', async () => {
      const mockObservation = {
        sessionId: 'ses_test123',
        pageId: 'pg_test123',
        revision: 1,
        url: 'https://example.com',
        title: 'Example Domain',
        status: 'interactive',
        summary: 'Page with links',
        elements: [
          {
            ref: 'e1_0',
            role: 'link',
            name: 'More information',
            visible: true,
            enabled: true,
          },
        ],
        truncated: false,
        untrustedContent: true,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockObservation,
      });

      const observation = await client.sessions.observe('ses_test123', 'pg_test123', {
        mode: 'interactive',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/sessions/ses_test123/pages/pg_test123/observe',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ mode: 'interactive' }),
        })
      );

      expect(observation.url).toBe('https://example.com');
      expect(observation.elements).toHaveLength(1);
      expect(observation.elements[0].ref).toBe('e1_0');
    });

    it('should support different observation modes', async () => {
      const modes = ['interactive', 'content', 'accessibility'];

      for (const mode of modes) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            sessionId: 'ses_test123',
            pageId: 'pg_test123',
            revision: 1,
            elements: [],
          }),
        });

        await client.sessions.observe('ses_test123', 'pg_test123', { mode });
      }

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('action execution', () => {
    it('should execute click action', async () => {
      const mockResponse = {
        status: 'success',
        actionId: 'act_test123',
        newRevision: 2,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const result = await client.sessions.executeAction('ses_test123', 'pg_test123', {
        action: 'click',
        target: { ref: 'e1_0' },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/sessions/ses_test123/pages/pg_test123/act',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            action: 'click',
            target: { ref: 'e1_0' },
          }),
        })
      );

      expect(result.status).toBe('success');
      expect(result.newRevision).toBe(2);
    });

    it('should execute fill action', async () => {
      const mockResponse = {
        status: 'success',
        actionId: 'act_test456',
        newRevision: 3,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const result = await client.sessions.executeAction('ses_test123', 'pg_test123', {
        action: 'fill',
        target: { ref: 'e1_1' },
        value: 'test@example.com',
      });

      expect(result.status).toBe('success');
      expect(result.newRevision).toBe(3);
    });

    it('should handle stale target error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 'STALE_TARGET',
            message: 'Element reference is stale',
            retryable: true,
          },
        }),
      });

      await expect(
        client.sessions.executeAction('ses_test123', 'pg_test123', {
          action: 'click',
          target: { ref: 'e999_0' },
        })
      ).rejects.toThrow('STALE_TARGET: Element reference is stale');
    });

    it('should handle action with observe', async () => {
      const mockResponse = {
        status: 'success',
        actionId: 'act_test789',
        newRevision: 4,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const result = await client.sessions.executeAction('ses_test123', 'pg_test123', {
        action: 'click',
        target: { ref: 'e1_0' },
        observe: 'after',
      });

      expect(result.status).toBe('success');
      expect(result.newRevision).toBe(4);
    });
  });

  describe('screenshots', () => {
    it('should capture a screenshot artifact', async () => {
      const mockResponse = {
        artifactId: 'art_test123',
        type: 'screenshot',
        contentType: 'image/png',
        sizeBytes: 1024,
        url: '/sessions/ses_test123/artifacts/art_test123',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const artifact = await client.sessions.screenshot('ses_test123', 'pg_test123', {
        fullPage: true,
        format: 'png',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/sessions/ses_test123/pages/pg_test123/screenshot',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ fullPage: true, format: 'png' }),
        })
      );
      expect(artifact.artifactId).toBe('art_test123');
      expect(artifact.contentType).toBe('image/png');
    });

    it('should default to an empty request body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          artifactId: 'art_1',
          type: 'screenshot',
          contentType: 'image/png',
          sizeBytes: 10,
          url: '/a',
        }),
      });

      await client.sessions.screenshot('ses_1', 'pg_1');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: JSON.stringify({}) })
      );
    });

    it('should surface a screenshot error as AgentBrowserError', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 'INVALID_REQUEST',
            message: 'Unsupported screenshot format: bmp',
            retryable: false,
          },
        }),
      });

      await expect(
        client.sessions.screenshot('ses_1', 'pg_1', { format: 'bmp' as never })
      ).rejects.toThrow('INVALID_REQUEST');
    });
  });

  describe('error handling', () => {
    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(client.sessions.create({ tenantId: 'tenant_1' })).rejects.toThrow(
        'Network error'
      );
    });

    it('should handle timeout errors', async () => {
      const clientWithTimeout = new AgentBrowserClient({
        baseUrl: 'http://localhost:3000',
        timeout: 1,
      });

      mockFetch.mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 100)));

      await expect(clientWithTimeout.sessions.create({ tenantId: 'tenant_1' })).rejects.toThrow();
    });

    it('should handle 404 errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({
          error: {
            code: 'NOT_FOUND',
            message: 'Session not found',
            retryable: false,
          },
        }),
      });

      await expect(client.sessions.get('nonexistent')).rejects.toThrow(
        'NOT_FOUND: Session not found'
      );
    });

    it('should handle 500 errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error',
            retryable: false,
          },
        }),
      });

      await expect(client.sessions.create({ tenantId: 'tenant_1' })).rejects.toThrow(
        'INTERNAL_ERROR: Internal server error'
      );
    });
  });
});
