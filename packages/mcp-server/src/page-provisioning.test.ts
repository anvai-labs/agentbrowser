import { expect, it, vi } from 'vitest';
import { type McpClient, type McpDependencies, buildMcpServer } from './mcp-server.js';

function fixture(options: Partial<McpDependencies> = {}) {
  const sessions = {
    createPage: vi
      .fn()
      .mockResolvedValue({ pageId: 'server-minted', sessionId: 's', status: 'ready' }),
    listPages: vi.fn().mockResolvedValue([{ pageId: 'server-minted' }]),
  };
  const server = buildMcpServer({
    createClient: () => ({ sessions }) as unknown as McpClient,
    ...options,
  });
  const exchange = async (method: string, params: unknown = {}) => {
    const result = await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    if (!result) throw new Error('Missing MCP response');
    return JSON.parse(result);
  };
  const call = (name: string, args: Record<string, unknown>) =>
    exchange('tools/call', { name, arguments: args });
  return { sessions, exchange, call };
}

it('provisions and lists server-owned pages through the existing SDK', async () => {
  const f = fixture();
  const created = await f.call('browser_page_create', {
    sessionId: 's',
    url: 'https://example.com/',
    operationId: 'create-1',
  });
  expect(created.result.isError).toBeUndefined();
  expect(JSON.parse(created.result.content[0].text).pageId).toBe('server-minted');
  expect(f.sessions.createPage).toHaveBeenCalledWith(
    's',
    { url: 'https://example.com/' },
    { operationId: 'create-1' }
  );
  const listed = await f.call('browser_pages', { sessionId: 's' });
  expect(listed.result.isError).toBeUndefined();
  expect(JSON.parse(listed.result.content[0].text)).toEqual({
    sessionId: 's',
    pages: [{ pageId: 'server-minted' }],
  });
  expect(f.sessions.listPages).toHaveBeenCalledWith('s');
});

it('creates a blank page without inventing a URL or an operation ID', async () => {
  const f = fixture();
  expect((await f.call('browser_page_create', { sessionId: 's' })).result.isError).toBeUndefined();
  expect(f.sessions.createPage).toHaveBeenCalledWith('s', undefined);
});

it.each([
  { sessionId: '' },
  { sessionId: 's', url: 42 },
  { sessionId: 's', url: 'file:///private' },
  { sessionId: 's', operationId: 'bad id' },
])('refuses invalid provisioning input before SDK dispatch: %j', async (args) => {
  const f = fixture();
  expect((await f.call('browser_page_create', args)).result.isError).toBe(true);
  expect(f.sessions.createPage).not.toHaveBeenCalled();
});

it('binds page creation to the delegated session and requires a caller-known ID', async () => {
  const f = fixture({ sessionId: 's' });
  expect((await f.call('browser_page_create', {})).result.isError).toBe(true);
  expect(
    (await f.call('browser_page_create', { sessionId: 'other', operationId: 'create-1' })).result
      .isError
  ).toBe(true);
  expect(f.sessions.createPage).not.toHaveBeenCalled();
  expect(
    (await f.call('browser_page_create', { operationId: 'create-1' })).result.isError
  ).toBeUndefined();
  expect(f.sessions.createPage).toHaveBeenCalledWith('s', undefined, { operationId: 'create-1' });
  const tools = (await f.exchange('tools/list')).result.tools;
  expect(
    tools.find((tool: { name: string }) => tool.name === 'browser_page_create').inputSchema.required
  ).toEqual(['operationId']);
});

it('does not retry uncertain creation or claim that inventory correlates its result', async () => {
  const f = fixture();
  f.sessions.createPage.mockRejectedValue(new Error('TIMEOUT: outcome may be unknown'));
  const result = await f.call('browser_page_create', { sessionId: 's' });
  expect(result.result.isError).toBe(true);
  expect(f.sessions.createPage).toHaveBeenCalledTimes(1);
  expect(f.sessions.listPages).not.toHaveBeenCalled();
});

it('respects mode capabilities in discovery and execution', async () => {
  const f = fixture({ mode: 'application' });
  const tools = (await f.exchange('tools/list')).result.tools;
  expect(tools.map((tool: { name: string }) => tool.name)).not.toContain('browser_page_create');
  expect((await f.call('browser_page_create', { sessionId: 's' })).error).toBeDefined();
  expect(f.sessions.createPage).not.toHaveBeenCalled();
});
