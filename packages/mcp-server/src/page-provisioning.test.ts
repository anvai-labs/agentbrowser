import { expect, it, vi } from 'vitest';
import { buildMcpServer, type McpClient, type McpDependencies } from './mcp-server.js';

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
  const created = await f.call('page_create', {
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
  const listed = await f.call('pages', { sessionId: 's' });
  expect(listed.result.isError).toBeUndefined();
  expect(JSON.parse(listed.result.content[0].text)).toEqual({
    sessionId: 's',
    pages: [{ pageId: 'server-minted' }],
  });
  expect(f.sessions.listPages).toHaveBeenCalledWith('s');
});

it('creates a blank page without inventing a URL or an operation ID', async () => {
  const f = fixture();
  expect((await f.call('page_create', { sessionId: 's' })).result.isError).toBeUndefined();
  expect(f.sessions.createPage).toHaveBeenCalledWith('s', undefined);
});

it.each([
  { sessionId: '' },
  { sessionId: 's', url: 42 },
  { sessionId: 's', url: 'file:///private' },
  { sessionId: 's', operationId: 'bad id' },
])('refuses invalid provisioning input before SDK dispatch: %j', async (args) => {
  const f = fixture();
  expect((await f.call('page_create', args)).result.isError).toBe(true);
  expect(f.sessions.createPage).not.toHaveBeenCalled();
});

it('binds page creation to the delegated session and requires a caller-known ID', async () => {
  const f = fixture({ sessionId: 's' });
  expect((await f.call('page_create', {})).result.isError).toBe(true);
  expect(
    (await f.call('page_create', { sessionId: 'other', operationId: 'create-1' })).result.isError
  ).toBe(true);
  expect(f.sessions.createPage).not.toHaveBeenCalled();
  expect((await f.call('page_create', { operationId: 'create-1' })).result.isError).toBeUndefined();
  expect(f.sessions.createPage).toHaveBeenCalledWith('s', undefined, { operationId: 'create-1' });
  const tools = (await f.exchange('tools/list')).result.tools;
  expect(
    tools.find((tool: { name: string }) => tool.name === 'page_create').inputSchema.required
  ).toEqual(['operationId']);
});

it('does not retry uncertain creation or claim that inventory correlates its result', async () => {
  const f = fixture();
  f.sessions.createPage.mockRejectedValue(new Error('TIMEOUT: outcome may be unknown'));
  const result = await f.call('page_create', { sessionId: 's' });
  expect(result.result.isError).toBe(true);
  expect(f.sessions.createPage).toHaveBeenCalledTimes(1);
  expect(f.sessions.listPages).not.toHaveBeenCalled();
});

it('respects mode capabilities in discovery and execution', async () => {
  const f = fixture({ mode: 'application' });
  const tools = (await f.exchange('tools/list')).result.tools;
  expect(tools.map((tool: { name: string }) => tool.name)).not.toContain('page_create');
  expect((await f.call('page_create', { sessionId: 's' })).error).toBeDefined();
  expect(f.sessions.createPage).not.toHaveBeenCalled();
});

it.each(['2024-11-05', '2025-06-18'])(
  'reports a page-create redirect scope denial without a success receipt or retry (%s)',
  async (protocolVersion) => {
    const f = fixture();
    await f.exchange('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'fixture', version: '1' },
    });
    f.sessions.createPage.mockRejectedValue(
      Object.assign(new Error('private driver URL https://private.invalid/?canary=1'), {
        code: 'POLICY_DENIED',
        details: {
          reason: 'egress_policy',
          scope: 'SCOPE_PATH_DENIED',
          url: 'https://private.invalid/?canary=1',
        },
      })
    );
    const { result } = await f.call('page_create', {
      sessionId: 's',
      url: 'https://example.com/redirect',
      operationId: 'create-redirect',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: 'POLICY_DENIED',
      retryable: false,
      details: { reason: 'egress_policy', scope: 'SCOPE_PATH_DENIED' },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|canary|server-minted/);
    expect(f.sessions.createPage).toHaveBeenCalledTimes(1);
    expect(f.sessions.listPages).not.toHaveBeenCalled();
  }
);

it.each(['2024-11-05', '2025-06-18'])(
  'keeps generic page-create failures bounded on %s',
  async (protocolVersion) => {
    const f = fixture();
    await f.exchange('initialize', { protocolVersion });
    for (const [code, reason] of [
      ['NAVIGATION_TIMEOUT', 'dns_timeout'],
      ['POLICY_DENIED', 'egress_policy'],
      ['INTERNAL', 'browser_error_document'],
      ['INTERNAL', 'engine_error'],
    ]) {
      f.sessions.createPage.mockRejectedValueOnce(
        Object.assign(new Error('private-driver-prose'), {
          code,
          retryable: true,
          details: {
            reason,
            url: 'https://private.invalid/?token=fixture-only',
            headers: 'private-header',
          },
        })
      );
      const { result } = await f.call('page_create', {
        sessionId: 's',
        url: 'https://example.com/',
      });
      const expected = {
        error: {
          code,
          message: `Navigation failed: ${reason}`,
          retryable: false,
          details: { reason },
        },
      };
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(expected);
      expect(JSON.parse(result.content[0].text)).toEqual(expected);
      expect(JSON.stringify(result)).not.toMatch(/private|fixture-only|server-minted/);
    }
    expect(f.sessions.createPage).toHaveBeenCalledTimes(4);
    expect(f.sessions.listPages).not.toHaveBeenCalled();
  }
);
