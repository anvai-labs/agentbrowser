import type { AGENT_MODE_IDS } from '@agentbrowser/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type McpClient, buildMcpServer } from './mcp-server.js';

function fixture(options: { sessionId?: string; mode?: (typeof AGENT_MODE_IDS)[number] } = {}) {
  const events = vi.fn();
  const sessions = { events };
  const server = buildMcpServer({
    createClient: () => ({ sessions }) as unknown as McpClient,
    ...options,
  });
  const exchange = async (method: string, params: unknown = {}) => {
    const response = await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    if (!response) throw new Error('Missing MCP response');
    return JSON.parse(response);
  };
  const call = async (args: Record<string, unknown>) => {
    const response = await exchange('tools/call', {
      name: 'browser_events_replay',
      arguments: args,
    });
    const text = response?.result?.content?.[0]?.text;
    if (text === undefined) return response;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text; // UsageError text is plain, not JSON.
    }
  };
  return { events, exchange, call };
}

describe('browser_events_replay', () => {
  it('is listed in the unbound profile with the sessionId + paging schema', async () => {
    const f = fixture();
    const tools = (await f.exchange('tools/list')).result.tools as Array<{
      name: string;
      inputSchema: { properties: Record<string, unknown>; required?: string[] };
    }>;
    const tool = tools.find((candidate) => candidate.name === 'browser_events_replay');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties).toMatchObject({
      sessionId: { type: 'string', minLength: 1 },
      type: { type: 'string' },
      since: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
    });
    expect(tool?.inputSchema.required).toEqual(['sessionId']);
  });

  it('passes a type filter through and returns the ledger array unpaged', async () => {
    const f = fixture();
    f.events.mockResolvedValue([{ type: 'console.error', data: { text: 'boom' } }]);
    const result = await f.call({ sessionId: 'ses_1', type: 'console.error' });
    expect(f.events).toHaveBeenCalledWith('ses_1', 'console.error');
    expect(result).toMatchObject({ events: [{ type: 'console.error' }], nextCursor: -1 });
  });

  it('pages a typed stream by cursor', async () => {
    const f = fixture();
    f.events.mockResolvedValue({
      events: [
        { type: 'console.error', seq: 4 },
        { type: 'console.error', seq: 5 },
      ],
      nextCursor: 5,
    });
    const result = await f.call({
      sessionId: 'ses_1',
      type: 'console.error',
      since: 3,
      limit: 2,
    });
    expect(f.events).toHaveBeenCalledWith('ses_1', {
      type: 'console.error',
      since: 3,
      limit: 2,
    });
    expect(result).toMatchObject({
      events: [
        { seq: 4, type: 'console.error' },
        { seq: 5, type: 'console.error' },
      ],
      nextCursor: 5,
    });
  });

  it('refuses since/limit without a type filter', async () => {
    const f = fixture();
    const result = await f.call({ sessionId: 'ses_1', since: 3 });
    expect(JSON.stringify(result)).toContain('type filter');
  });
});
