/**
 * TDD Tests for the AgentBrowser MCP server (ADR-009)
 *
 * The MCP surface exposes a small set of high-level, safe, composable tools.
 * The JSON-RPC layer is driven directly with injected dependencies, mirroring
 * how a stdio client (e.g. victor-ai) drives the real binary.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMcpServer } from './mcp-server';
import type { McpDependencies } from './mcp-server';

describe('AgentBrowser MCP server', () => {
  let sessions: Record<string, ReturnType<typeof vi.fn>>;
  let deps: McpDependencies;
  let server: ReturnType<typeof buildMcpServer>;

  const request = (id: string, method: string, params: unknown = {}) =>
    server.handle(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

  const call = (id: string, name: string, args: Record<string, unknown>) =>
    request(id, 'tools/call', { name, arguments: args });

  const textOf = (response: unknown) =>
    JSON.parse((response as { result: { content: { text: string }[] } }).result.content[0].text);

  beforeEach(() => {
    sessions = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'ses_1',
        status: 'ready',
        createdAt: '2026-08-23T10:00:00Z',
      }),
      close: vi.fn().mockResolvedValue(undefined),
      cookies: vi
        .fn()
        .mockResolvedValue([{ name: 'sid', value: 'abc', domain: 'example.com', path: '/' }]),
      createPage: vi
        .fn()
        .mockResolvedValue({ pageId: 'pg_1', sessionId: 'ses_1', status: 'ready' }),
      navigate: vi.fn().mockResolvedValue({
        status: 'success',
        url: 'https://example.com',
        redirectChain: [],
      }),
      observe: vi.fn().mockResolvedValue({
        sessionId: 'ses_1',
        pageId: 'pg_1',
        revision: 1,
        url: 'https://example.com',
        title: 'Example',
        status: 'interactive',
        summary: 'Page with 1 button',
        elements: [{ ref: 'e1_0', role: 'button', name: 'Submit', visible: true, enabled: true }],
        truncated: false,
        untrustedContent: true,
      }),
      executeAction: vi.fn().mockResolvedValue({
        status: 'success',
        actionId: 'act_1',
        newRevision: 2,
      }),
      extract: vi.fn().mockResolvedValue({
        data: { markdown: '# Report' },
        evidence: [{ url: 'https://example.com', revision: 2, hash: 'abc12345' }],
      }),
      pdf: vi.fn().mockResolvedValue({
        artifactId: 'pdf_1',
        type: 'pdf',
        contentType: 'application/pdf',
        sizeBytes: 4096,
        url: '/sessions/ses_1/artifacts/pdf_1',
      }),
      screenshot: vi.fn().mockResolvedValue({
        artifactId: 'art_1',
        type: 'screenshot',
        contentType: 'image/png',
        sizeBytes: 2048,
        url: '/sessions/ses_1/artifacts/art_1',
      }),
    };

    deps = {
      createClient: vi.fn().mockReturnValue({ sessions }),
      serverInfo: { name: 'agentbrowser', version: '1.0.0' },
    };

    server = buildMcpServer(deps);
  });

  describe('initialize', () => {
    it('should complete the initialize handshake', async () => {
      const response = JSON.parse(
        await request('1', 'initialize', {
          protocolVersion: '2024-11-05',
          clientInfo: { name: 'victor', version: '0.9.0' },
        })
      );

      expect(response.id).toBe('1');
      expect(response.result.protocolVersion).toBe('2024-11-05');
      expect(response.result.serverInfo.name).toBe('agentbrowser');
      expect(response.result.capabilities.tools).toBeDefined();
    });
  });

  describe('browser_cookies (TD-BROWSER-6)', () => {
    it('lists the tool', async () => {
      const response = JSON.parse(await request('td1', 'tools/list'));
      const names = response.result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toContain('browser_cookies');
    });

    it('exports cookies through the service client', async () => {
      const response = JSON.parse(
        await request('td2', 'tools/call', {
          name: 'browser_cookies',
          arguments: { sessionId: 'ses_1' },
        })
      );
      expect(sessions.cookies).toHaveBeenCalledWith('ses_1');
      const inner = JSON.parse(response.result.content[0].text);
      expect(inner.sessionId).toBe('ses_1');
      expect(inner.cookies[0]).toMatchObject({ name: 'sid', value: 'abc' });
    });
  });

  describe('tools/list', () => {
    it('should expose the ADR-009 high-level tool surface', async () => {
      const response = JSON.parse(await request('2', 'tools/list'));
      const names = response.result.tools.map((t: { name: string }) => t.name);

      expect(names).toContain('browser_create');
      expect(names).toContain('browser_close');
      expect(names).toContain('browser_navigate');
      expect(names).toContain('browser_observe');
      expect(names).toContain('browser_act');
      expect(names).toContain('browser_screenshot');
    });

    it('should expose browser_pdf', async () => {
      const response = JSON.parse(await request('3c', 'tools/list'));
      const names = response.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain('browser_pdf');
    });

    it('should expose browser_extract', async () => {
      const response = JSON.parse(await request('3b', 'tools/list'));
      const names = response.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain('browser_extract');
    });

    it('should not expose raw engine operations', async () => {
      const response = JSON.parse(await request('3', 'tools/list'));
      const names = response.result.tools.map((t: { name: string }) => t.name);

      // ADR-009: no evaluate, no init scripts, no routing, no selectors
      expect(names).not.toContain('browser_evaluate');
      expect(names).not.toContain('browser_route');
      expect(names.some((n: string) => /selector|xpath|mouse|keyboard/.test(n))).toBe(false);
    });

    it('should give every tool a description and an input schema', async () => {
      const response = JSON.parse(await request('4', 'tools/list'));

      for (const tool of response.result.tools) {
        expect(tool.description).toEqual(expect.any(String));
        expect(tool.inputSchema.type).toBe('object');
      }
    });

    it('should require element refs, never selectors, on browser_act', async () => {
      const response = JSON.parse(await request('5', 'tools/list'));
      const act = response.result.tools.find((t: { name: string }) => t.name === 'browser_act');

      expect(act.inputSchema.properties.target.properties.ref.pattern).toBe('^e\\d+_\\d+$');
      expect(JSON.stringify(act.inputSchema)).not.toMatch(/selector|xpath/i);
    });
  });

  describe('tools/call', () => {
    it('should create a session', async () => {
      const response = JSON.parse(await call('6', 'browser_create', { tenantId: 'tenant_1' }));

      expect(sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant_1' })
      );
      expect(textOf(response).sessionId).toBe('ses_1');
      expect(response.result.isError).toBeFalsy();
    });

    it('should navigate', async () => {
      const response = JSON.parse(
        await call('7', 'browser_navigate', {
          sessionId: 'ses_1',
          pageId: 'pg_1',
          url: 'https://example.com',
        })
      );

      expect(sessions.navigate).toHaveBeenCalledWith('ses_1', 'pg_1', {
        url: 'https://example.com',
      });
      expect(textOf(response).status).toBe('success');
    });

    it('should observe and return the semantic observation', async () => {
      const response = JSON.parse(
        await call('8', 'browser_observe', { sessionId: 'ses_1', pageId: 'pg_1' })
      );

      const observation = textOf(response);
      expect(observation.elements[0].ref).toBe('e1_0');
      expect(observation.untrustedContent).toBe(true);
    });

    it('should act through a ref', async () => {
      const response = JSON.parse(
        await call('9', 'browser_act', {
          sessionId: 'ses_1',
          pageId: 'pg_1',
          action: 'click',
          target: { ref: 'e1_0' },
        })
      );

      expect(sessions.executeAction).toHaveBeenCalledWith('ses_1', 'pg_1', {
        action: 'click',
        target: { ref: 'e1_0' },
      });
      expect(textOf(response).newRevision).toBe(2);
    });

    it('should extract through the tool', async () => {
      const response = JSON.parse(
        await call('10b', 'browser_extract', {
          sessionId: 'ses_1',
          pageId: 'pg_1',
          format: 'markdown',
        })
      );

      expect(sessions.extract).toHaveBeenCalledWith('ses_1', 'pg_1', { format: 'markdown' });
      const extracted = textOf(response);
      expect(extracted.data.markdown).toBe('# Report');
      expect(extracted.evidence[0].hash).toBe('abc12345');
    });

    it('should reject an unknown extract format', async () => {
      const response = JSON.parse(
        await call('10c', 'browser_extract', {
          sessionId: 'ses_1',
          pageId: 'pg_1',
          format: 'yaml',
        })
      );

      expect(response.result.isError).toBe(true);
      expect(JSON.stringify(response.result.content)).toContain('format');
    });

    it('should capture a PDF through the tool', async () => {
      const response = JSON.parse(
        await call('10d', 'browser_pdf', {
          sessionId: 'ses_1',
          pageId: 'pg_1',
          printBackground: true,
        })
      );

      expect(sessions.pdf).toHaveBeenCalledWith('ses_1', 'pg_1', { printBackground: true });
      expect(textOf(response).artifactId).toBe('pdf_1');
    });

    it('should capture a screenshot', async () => {
      const response = JSON.parse(
        await call('10', 'browser_screenshot', { sessionId: 'ses_1', pageId: 'pg_1' })
      );

      expect(textOf(response).artifactId).toBe('art_1');
    });

    it('should close a session', async () => {
      await call('11', 'browser_close', { sessionId: 'ses_1' });

      expect(sessions.close).toHaveBeenCalledWith('ses_1');
    });
  });

  describe('safety', () => {
    it('should reject a selector-shaped target without calling the API', async () => {
      const response = JSON.parse(
        await call('12', 'browser_act', {
          sessionId: 'ses_1',
          pageId: 'pg_1',
          action: 'click',
          target: { ref: 'button.submit' },
        })
      );

      expect(sessions.executeAction).not.toHaveBeenCalled();
      expect(response.result.isError).toBe(true);
      expect(JSON.stringify(response.result.content)).toContain('e<revision>_<ordinal>');
    });

    it('should surface STALE_TARGET as an error result, not a crash', async () => {
      sessions.executeAction.mockRejectedValue(
        Object.assign(new Error('STALE_TARGET: reference is stale'), {
          name: 'AgentBrowserError',
          code: 'STALE_TARGET',
          retryable: true,
        })
      );

      const response = JSON.parse(
        await call('13', 'browser_act', {
          sessionId: 'ses_1',
          pageId: 'pg_1',
          action: 'click',
          target: { ref: 'e1_0' },
        })
      );

      expect(response.result.isError).toBe(true);
      expect(JSON.stringify(response.result.content)).toContain('STALE_TARGET');
      expect(JSON.stringify(response.result.content)).toContain('observe');
    });

    it('should mark observations as untrusted content', async () => {
      const response = JSON.parse(
        await call('14', 'browser_observe', { sessionId: 'ses_1', pageId: 'pg_1' })
      );

      // The observation body itself carries untrustedContent, and the wrapper
      // tells the agent how to treat it.
      expect(JSON.stringify(response.result.content).toLowerCase()).toContain('untrusted');
    });

    it('should reject a non-http(s) navigation target', async () => {
      const response = JSON.parse(
        await call('15', 'browser_navigate', {
          sessionId: 'ses_1',
          pageId: 'pg_1',
          url: 'file:///etc/passwd',
        })
      );

      expect(sessions.navigate).not.toHaveBeenCalled();
      expect(response.result.isError).toBe(true);
      expect(JSON.stringify(response.result.content)).toContain('file:');
    });
  });

  describe('JSON-RPC layer', () => {
    it('should answer notifications with null', async () => {
      const response = await server.handle(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
      );
      expect(response).toBeNull();
    });

    it('should answer ping', async () => {
      const response = JSON.parse(await request('16', 'ping'));
      expect(response.result).toEqual({});
    });

    it('should return method-not-found for unknown methods', async () => {
      const response = JSON.parse(await request('17', 'resources/list'));
      expect(response.error.code).toBe(-32601);
    });

    it('should return invalid-params for an unknown tool', async () => {
      const response = JSON.parse(await call('18', 'browser_teleport', {}));
      expect(response.error.code).toBe(-32602);
    });

    it('should reject malformed JSON input', async () => {
      const response = JSON.parse(await server.handle('{not json'));
      expect(response.error.code).toBe(-32700);
    });

    it('should echo the request id in responses', async () => {
      const response = JSON.parse(await request('abc-123', 'ping'));
      expect(response.id).toBe('abc-123');
    });
  });
});
