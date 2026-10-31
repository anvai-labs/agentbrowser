import type { ClientOptions } from '@agentbrowser/sdk-typescript';
import { expect, it, vi } from 'vitest';
import { buildMcpServer, type McpClient } from './mcp-server.js';

it('delivers live denial metadata as MCP logging notifications and aborts observers on close', async () => {
  const notices: string[] = [];
  let cancelled = false;
  let connectionOptions: ClientOptions;
  let inheritedSignal: AbortSignal | undefined;
  const session = {
    sessionId: 's',
    status: 'active',
    engine: { name: 'fake', version: '1' },
    createdAt: new Date().toISOString(),
    ttlMs: 10000,
    idleTimeoutMs: 10000,
    pages: 0,
    trace: 'denials' as const,
  };
  const client = {
    sessions: {
      create: vi.fn(async () => session),
      createPage: vi.fn(async () => ({ pageId: 'p' })),
      close: vi.fn(async () => {}),
      traceDenials: async function* (
        _id: string,
        options: { signal: AbortSignal; onReady: () => void }
      ) {
        inheritedSignal = connectionOptions.requestSignal?.();
        options.onReady();
        yield {
          type: 'scope.denied' as const,
          timestamp: new Date().toISOString(),
          sessionId: 's',
          data: {
            scope: 'SCOPE_METHOD_DENIED' as const,
            method: 'PUT',
            url: 'https://vinted.test/verify',
            hostname: 'vinted.test',
          },
        };
        await new Promise<void>((resolve) => {
          options.signal.addEventListener(
            'abort',
            () => {
              cancelled = true;
              resolve();
            },
            { once: true }
          );
        });
      },
    },
  } as unknown as McpClient;
  const server = buildMcpServer({
    createClient: (options) => {
      connectionOptions = options;
      return client;
    },
    mode: 'bounty',
    notificationSink: (line) => notices.push(line),
  });
  await server.handle(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    })
  );
  const result = await server.handle(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'session_create', arguments: { tenantId: 'tenant' } },
    })
  );
  expect(result).not.toContain('isError":true');
  await expect.poll(() => notices.length).toBeGreaterThan(0);
  expect(JSON.parse(notices[0]!)).toMatchObject({
    method: 'notifications/message',
    params: {
      level: 'warning',
      data: { type: 'scope.denied', data: { scope: 'SCOPE_METHOD_DENIED', method: 'PUT' } },
    },
  });
  expect(inheritedSignal).toBeUndefined();
  await server.close();
  expect(cancelled).toBe(true);
});
