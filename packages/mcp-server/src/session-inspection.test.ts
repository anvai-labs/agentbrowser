import { AGENT_MODE_IDS } from '@agentbrowser/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type McpClient, buildMcpServer } from './mcp-server.js';

function fixture(options: { sessionId?: string; mode?: (typeof AGENT_MODE_IDS)[number] } = {}) {
  const session = {
    sessionId: options.sessionId ?? 'ses_1',
    status: 'ready',
    engine: { name: 'selected-engine', version: '2.0.0' },
    createdAt: '2026-09-24T00:00:00.000Z',
    pages: 1,
  };
  const pages = [{ pageId: 'pg_1', sessionId: session.sessionId, status: 'ready' }];
  const control = { state: 'AGENT_ACTIVE' };
  const sessions = {
    get: vi.fn().mockResolvedValue(session),
    listPages: vi.fn().mockResolvedValue(pages),
    control: vi.fn().mockResolvedValue(control),
  };
  const server = buildMcpServer({
    createClient: () => ({ sessions }) as unknown as McpClient,
    ...options,
  });
  const exchange = async (method: string, params: unknown = {}) => {
    const response = await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    if (!response) throw new Error('Missing MCP response');
    return JSON.parse(response);
  };
  const call = (args: Record<string, unknown>) =>
    exchange('tools/call', { name: 'browser_session', arguments: args });
  return { sessions, session, pages, control, exchange, call };
}

describe('browser_session inspection', () => {
  it('is available unbound and requires the inspected session ID', async () => {
    const f = fixture();
    const tool = (await f.exchange('tools/list')).result.tools.find(
      (candidate: { name: string }) => candidate.name === 'browser_session'
    );
    expect(tool.inputSchema).toMatchObject({
      properties: { sessionId: { type: 'string', minLength: 1 } },
      required: ['sessionId'],
    });

    const missing = await f.call({});
    expect(missing.result.isError).toBe(true);
    expect(f.sessions.get).not.toHaveBeenCalled();

    const response = await f.call({ sessionId: 'ses_1' });
    expect(JSON.parse(response.result.content[0].text)).toEqual({
      sessionId: 'ses_1',
      session: f.session,
      pages: f.pages,
    });
    expect(f.sessions.get).toHaveBeenCalledWith('ses_1');
    expect(f.sessions.listPages).toHaveBeenCalledWith('ses_1');
    expect(f.sessions.control).not.toHaveBeenCalled();
  });

  it('preserves the bound envelope and adds session metadata', async () => {
    const f = fixture({ sessionId: 'bound' });
    const tool = (await f.exchange('tools/list')).result.tools.find(
      (candidate: { name: string }) => candidate.name === 'browser_session'
    );
    expect(tool.inputSchema.required ?? []).not.toContain('sessionId');

    const response = await f.call({});
    expect(JSON.parse(response.result.content[0].text)).toEqual({
      sessionId: 'bound',
      session: f.session,
      control: f.control,
      pages: f.pages,
    });
    expect(f.sessions.get).toHaveBeenCalledWith('bound');
    expect(f.sessions.control).toHaveBeenCalledWith('bound');
    expect(f.sessions.listPages).toHaveBeenCalledWith('bound');
  });

  it('refuses a mismatched bound ID before any inspection call', async () => {
    const f = fixture({ sessionId: 'bound' });
    const response = await f.call({ sessionId: 'other' });
    expect(response.result.isError).toBe(true);
    expect(f.sessions.get).not.toHaveBeenCalled();
    expect(f.sessions.control).not.toHaveBeenCalled();
    expect(f.sessions.listPages).not.toHaveBeenCalled();
  });

  it('requires both browser capabilities in every bound and unbound catalog', async () => {
    for (const mode of AGENT_MODE_IDS) {
      for (const bound of [false, true]) {
        const f = fixture({ mode, ...(bound ? { sessionId: 'bound' } : {}) });
        const names = (await f.exchange('tools/list')).result.tools.map(
          (tool: { name: string }) => tool.name
        );
        expect(names.includes('browser_session'), `${bound ? 'bound' : 'unbound'}/${mode}`).toBe(
          mode !== 'application'
        );
      }
    }
  });

  it('keeps application-only discovery and direct dispatch unchanged', async () => {
    const unbound = fixture({ mode: 'application' });
    expect((await unbound.exchange('tools/list')).result.tools).toEqual([]);
    const refused = await unbound.call({ sessionId: 'ses_1' });
    expect(refused.error).toMatchObject({ code: -32602, message: 'Unknown tool: browser_session' });
    expect(unbound.sessions.get).not.toHaveBeenCalled();
    expect(unbound.sessions.listPages).not.toHaveBeenCalled();

    const bound = fixture({ mode: 'application', sessionId: 'bound' });
    expect(
      (await bound.exchange('tools/list')).result.tools.map((tool: { name: string }) => tool.name)
    ).toEqual(['browser_operation']);
    expect((await bound.call({})).error).toMatchObject({
      code: -32602,
      message: 'Unknown tool: browser_session',
    });
    expect(bound.sessions.get).not.toHaveBeenCalled();
    expect(bound.sessions.control).not.toHaveBeenCalled();
    expect(bound.sessions.listPages).not.toHaveBeenCalled();
  });

  it('does not publish partial inspection data when an HTTP dependency refuses', async () => {
    const f = fixture();
    f.sessions.get.mockRejectedValue(new Error('FORBIDDEN'));
    f.sessions.listPages.mockResolvedValue([{ pageId: 'private-page' }]);
    const response = await f.call({ sessionId: 'ses_1' });
    expect(response.result.isError).toBe(true);
    expect(JSON.stringify(response)).not.toContain('private-page');
    expect(f.sessions.get).toHaveBeenCalledTimes(1);
    expect(f.sessions.listPages).toHaveBeenCalledTimes(1);
  });
});
