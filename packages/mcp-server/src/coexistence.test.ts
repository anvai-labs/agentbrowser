import { expect, it, vi } from 'vitest';
import { type McpClient, buildMcpServer } from './mcp-server.js';
it('binds an agent to an existing session without exposing owner or cookie tools', async () => {
  const session = {
    sessionId: 's',
    status: 'ready',
    engine: { name: 'fake-engine', version: '1.0.0' },
    createdAt: '2026-09-24T00:00:00.000Z',
  };
  const sessions = {
    get: vi.fn().mockResolvedValue(session),
    control: vi.fn().mockResolvedValue({ state: 'AGENT_ACTIVE' }),
    listPages: vi.fn().mockResolvedValue([{ pageId: 'p' }]),
    snapshot: vi.fn(),
  };
  const server = buildMcpServer({
    createClient: () => ({ sessions }) as unknown as McpClient,
    sessionId: 's',
  });
  const call = async (method: string, params = {}) =>
    JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })))!);
  const list = await call('tools/list');
  const names = list.result.tools.map((t: { name: string }) => t.name);
  expect(names).toContain('browser_session');
  expect(names).not.toContain('browser_create');
  expect(names).not.toContain('browser_close');
  expect(names).not.toContain('browser_cookies');
  const attached = await call('tools/call', { name: 'browser_session', arguments: {} });
  expect(JSON.parse(attached.result.content[0].text)).toMatchObject({
    sessionId: 's',
    session,
    pages: [{ pageId: 'p' }],
  });
  const wrong = await call('tools/call', {
    name: 'browser_snapshot',
    arguments: { sessionId: 'other', pageId: 'p' },
  });
  expect(wrong.result.isError).toBe(true);
  expect(sessions.snapshot).not.toHaveBeenCalled();
});

it('requires a caller-known operation ID for bound mutations and forwards it outside action data', async () => {
  const sessions = { executeAction: vi.fn().mockResolvedValue({ status: 'success' }) };
  const server = buildMcpServer({
    createClient: () => ({ sessions }) as unknown as McpClient,
    sessionId: 's',
  });
  const call = async (args: Record<string, unknown>) =>
    JSON.parse(
      (await server.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'browser_act', arguments: args },
        })
      ))!
    );
  expect((await call({ pageId: 'p', action: 'press', key: 'Tab' })).result.isError).toBe(true);
  expect(sessions.executeAction).not.toHaveBeenCalled();
  expect(
    (await call({ pageId: 'p', operationId: 'known-1', action: 'press', key: 'Tab' })).result
      .isError
  ).toBeUndefined();
  expect(sessions.executeAction).toHaveBeenCalledWith(
    's',
    'p',
    { action: 'press', key: 'Tab' },
    { operationId: 'known-1' }
  );
});
