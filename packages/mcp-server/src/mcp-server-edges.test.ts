/**
 * Edge-branch coverage for the MCP tool handlers and the JSON-RPC wrapper:
 * argument validation refusals, optional-field forwarding, the delegated
 * browser_operation reconciler, and the internal-error path. Drives the same
 * transport-neutral handler with an injected fake client as mcp-server.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMcpServer } from './mcp-server.js';
import type { McpClient, McpDependencies, McpServer } from './mcp-server.js';

describe('AgentBrowser MCP server edge branches', () => {
  let sessions: Record<string, ReturnType<typeof vi.fn>>;
  let deps: McpDependencies;
  let server: ReturnType<typeof buildMcpServer>;

  const request = (id: string, method: string, params: unknown = {}) =>
    server.handle(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

  const call = (id: string, name: string, args: Record<string, unknown>) =>
    request(id, 'tools/call', { name, arguments: args });

  /** A tools/call result delivered as a tool error carries its text here. */
  const errorText = (response: string) => {
    const parsed = JSON.parse(response) as { result: { content: { text: string }[] } };
    return parsed.result.content[0].text;
  };

  beforeEach(() => {
    sessions = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'ses_1',
        status: 'ready',
        createdAt: '2026-08-23T10:00:00Z',
      }),
      close: vi.fn().mockResolvedValue(undefined),
      cookies: vi.fn().mockResolvedValue([]),
      plan: vi.fn().mockResolvedValue({ ok: true, completed: 0, results: [] }),
      snapshot: vi.fn().mockResolvedValue({
        url: 'https://example.com',
        mode: 'stable',
        revision: 1,
        fields: [],
      }),
      createPage: vi.fn().mockResolvedValue({ pageId: 'pg_1', sessionId: 'ses_1' }),
      navigate: vi.fn().mockResolvedValue({ status: 'success', url: 'https://example.com' }),
      observe: vi.fn().mockResolvedValue({ revision: 1, elements: [], truncated: false }),
      executeAction: vi.fn().mockResolvedValue({ status: 'success', newRevision: 2 }),
      extract: vi.fn().mockResolvedValue({ data: {}, evidence: [] }),
      pdf: vi.fn().mockResolvedValue({ artifactId: 'pdf_1', contentType: 'application/pdf' }),
      screenshot: vi.fn().mockResolvedValue({ artifactId: 'art_1', contentType: 'image/png' }),
      html: vi.fn().mockResolvedValue({
        artifactId: 'html_1',
        type: 'html',
        contentType: 'text/html; charset=utf-8',
        sizeBytes: 37,
        inline: {
          contentBase64: Buffer.from('<html><body>form values</body></html>').toString('base64'),
          byteSize: 37,
        },
      }),
      artifact: vi.fn().mockResolvedValue({
        metadata: { artifactId: 'html_1' },
        contentBase64: Buffer.from('<html>stored bytes</html>').toString('base64'),
      }),
    };

    deps = {
      createClient: vi.fn().mockReturnValue({ sessions } satisfies Partial<McpClient>),
      serverInfo: { name: 'agentbrowser', version: '1.0.0' },
    };

    server = buildMcpServer(deps);
  });

  describe('argument validation refusals', () => {
    it('browser_snapshot requires a pageId, not just a sessionId', async () => {
      const response = JSON.parse(await call('e1', 'browser_snapshot', { sessionId: 'ses_1' })) as {
        result: { isError: boolean };
      };
      expect(response.result.isError).toBe(true);
      expect(errorText(await call('e1b', 'browser_snapshot', { sessionId: 'ses_1' }))).toContain(
        'pageId is required'
      );
      expect(sessions.snapshot).not.toHaveBeenCalled();
    });

    it('browser_create requires a tenantId', async () => {
      const response = JSON.parse(await call('e2', 'browser_create', {}));
      expect(response.result.isError).toBe(true);
      expect(errorText(await call('e2b', 'browser_create', {}))).toContain('tenantId is required');
      expect(sessions.create).not.toHaveBeenCalled();
      expect(sessions.createPage).not.toHaveBeenCalled();
    });

    it('browser_autofill maps a protocol-invalid payload to a usage error without dispatching', async () => {
      sessions.autofill = vi.fn();
      const response = JSON.parse(
        await call('e3', 'browser_autofill', {
          sessionId: 'ses_1',
          pageId: 'pg_1',
          fields: 'not-an-array',
        })
      );
      expect(response.result.isError).toBe(true);
      expect(
        errorText(
          await call('e3b', 'browser_autofill', {
            sessionId: 'ses_1',
            pageId: 'pg_1',
            fields: 'not-an-array',
          })
        )
      ).toContain('Invalid autofill request');
      expect(sessions.autofill).not.toHaveBeenCalled();
    });
  });

  describe('optional argument forwarding', () => {
    it('browser_create forwards snapshotTimeoutMs', async () => {
      const response = JSON.parse(
        await call('e4', 'browser_create', { tenantId: 'tenant_1', snapshotTimeoutMs: 9000 })
      );
      expect(response.result.isError).toBeFalsy();
      expect(sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant_1', snapshotTimeoutMs: 9000 })
      );
    });

    it('browser_navigate forwards waitUntil', async () => {
      const response = JSON.parse(
        await call('e5', 'browser_navigate', {
          sessionId: 'ses_1',
          pageId: 'pg_1',
          url: 'https://example.com',
          waitUntil: 'networkidle',
        })
      );
      expect(response.result.isError).toBeFalsy();
      expect(sessions.navigate).toHaveBeenCalledWith('ses_1', 'pg_1', {
        url: 'https://example.com',
        waitUntil: 'networkidle',
      });
    });

    it('browser_observe forwards mode and numeric bounds', async () => {
      const response = JSON.parse(
        await call('e6', 'browser_observe', {
          sessionId: 'ses_1',
          pageId: 'pg_1',
          mode: 'content',
          maxElements: 25,
          maxBytes: 4096,
        })
      );
      expect(response.result.isError).toBeFalsy();
      expect(sessions.observe).toHaveBeenCalledWith('ses_1', 'pg_1', {
        mode: 'content',
        maxElements: 25,
        maxBytes: 4096,
      });
    });

    it('browser_observe rejects string cursors consistently with the canonical schema', async () => {
      const response = await call('e7', 'browser_observe', {
        sessionId: 'ses_1',
        pageId: 'pg_1',
        continueFrom: '40',
      });
      expect(JSON.parse(response).result.isError).toBe(true);
      expect(sessions.observe).not.toHaveBeenCalled();
    });

    it('browser_pdf forwards every print option', async () => {
      const response = JSON.parse(
        await call('e8', 'browser_pdf', {
          sessionId: 'ses_1',
          pageId: 'pg_1',
          landscape: true,
          displayHeaderFooter: true,
          printBackground: true,
        })
      );
      expect(response.result.isError).toBeFalsy();
      expect(sessions.pdf).toHaveBeenCalledWith('ses_1', 'pg_1', {
        landscape: true,
        displayHeaderFooter: true,
        printBackground: true,
      });
    });

    it('browser_pdf sends an empty request when no print option is set', async () => {
      const response = JSON.parse(
        await call('e8b', 'browser_pdf', { sessionId: 'ses_1', pageId: 'pg_1' })
      );
      expect(response.result.isError).toBeFalsy();
      expect(sessions.pdf).toHaveBeenCalledWith('ses_1', 'pg_1', {});
    });

    it('browser_screenshot forwards fullPage and format', async () => {
      const response = JSON.parse(
        await call('e9', 'browser_screenshot', {
          sessionId: 'ses_1',
          pageId: 'pg_1',
          fullPage: true,
          format: 'jpeg',
        })
      );
      expect(response.result.isError).toBeFalsy();
      expect(sessions.screenshot).toHaveBeenCalledWith('ses_1', 'pg_1', {
        fullPage: true,
        format: 'jpeg',
      });
    });
  });

  describe('browser_html stored-but-empty artifact', () => {
    it('refuses with a usage error when neither the export nor the store has bytes', async () => {
      sessions.html = vi.fn().mockResolvedValue({
        artifactId: 'html_9',
        type: 'html',
        contentType: 'text/html; charset=utf-8',
        sizeBytes: 5000,
      });
      sessions.artifact = vi.fn().mockResolvedValue({ metadata: { artifactId: 'html_9' } });
      const response = JSON.parse(
        await call('e10', 'browser_html', { sessionId: 'ses_1', pageId: 'pg_1' })
      );
      expect(response.result.isError).toBe(true);
      const text = errorText(
        await call('e10b', 'browser_html', { sessionId: 'ses_1', pageId: 'pg_1' })
      );
      expect(text).toContain('html_9');
      expect(text).toContain('without inline content');
      expect(sessions.artifact).toHaveBeenCalledWith('ses_1', 'html_9');
    });
  });

  describe('delegated browser_operation reconciler', () => {
    const delegatedCall = (bound: McpServer, id: string, args: Record<string, unknown>) =>
      bound.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'browser_operation', arguments: args },
        })
      );

    it('reconciles a lost response through the service client', async () => {
      sessions.operation = vi.fn().mockResolvedValue({ operationId: 'op_1', state: 'recorded' });
      const bound = buildMcpServer({ ...deps, sessionId: 'ses_1' });
      const response = JSON.parse(await delegatedCall(bound, 'e11', { operationId: 'op_1' }));
      expect(sessions.operation).toHaveBeenCalledWith('ses_1', 'op_1');
      expect(JSON.parse(response.result.content[0].text)).toEqual({
        operationId: 'op_1',
        state: 'recorded',
      });
      expect(response.result.isError).toBeFalsy();
    });

    it('refuses a non-string operationId without touching the client', async () => {
      sessions.operation = vi.fn();
      const bound = buildMcpServer({ ...deps, sessionId: 'ses_1' });
      const response = JSON.parse(await delegatedCall(bound, 'e12', { operationId: 42 }));
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toContain('operationId is required');
      expect(sessions.operation).not.toHaveBeenCalled();
    });
  });

  describe('JSON-RPC invalid roots', () => {
    it.each(['null', '[]', '[{}]', '42', 'true', '"text"'])(
      'returns invalid-request for %s without rejecting or dispatching',
      async (line) => {
        const response = await server.handle(line);
        expect(response).not.toBeNull();
        expect(JSON.parse(response ?? '{}')).toEqual({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid request' },
        });
        for (const method of Object.values(sessions)) expect(method).not.toHaveBeenCalled();
        expect(JSON.parse((await request('after-invalid', 'ping')) ?? '{}').result).toEqual({});
      }
    );

    it('preserves parse errors and valid notifications', async () => {
      expect(JSON.parse((await server.handle('{broken')) ?? '{}').error.code).toBe(-32700);
      expect(
        await server.handle('{"jsonrpc":"2.0","method":"notifications/initialized"}')
      ).toBeNull();
    });
  });

  describe('JSON-RPC internal error path', () => {
    it('maps an internal serialization failure to a -32603 error response', async () => {
      const hostile = buildMcpServer({
        ...deps,
        serverInfo: {
          name: 'agentbrowser',
          version: '1.0.0',
          toJSON() {
            throw new Error('boom');
          },
        } as unknown as { name: string; version: string },
      });
      const response = JSON.parse(
        (await hostile.handle(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18' },
          })
        )) ?? '{}'
      ) as { error: { code: number; message: string } };
      expect(response.error).toMatchObject({ code: -32603, message: 'boom' });
    });
  });

  describe('package entry point', () => {
    it('re-exports the server factory and version helpers', async () => {
      const entry = (await import('./index.js')) as typeof import('./mcp-server.js') &
        typeof import('./version.js');
      expect(typeof entry.buildMcpServer).toBe('function');
      expect(typeof entry.resolveVersion).toBe('function');
      const entryServer = entry.buildMcpServer(deps);
      expect(
        JSON.parse((await entryServer.handle('{"jsonrpc":"2.0","id":1,"method":"ping"}')) ?? '{}')
      ).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: {},
      });
    });
  });
});
