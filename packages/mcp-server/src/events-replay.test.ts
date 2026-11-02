import type { AGENT_MODE_IDS } from '@agentbrowser/protocol';
import { describe, expect, it, vi } from 'vitest';
import { rpcHarness } from './test-support/rpc-harness.js';

function fixture(options: { sessionId?: string; mode?: (typeof AGENT_MODE_IDS)[number] } = {}) {
  const events = vi.fn();
  const { exchange } = rpcHarness({ sessions: { events } }, options);
  const call = async (args: Record<string, unknown>) => {
    const response = await exchange('tools/call', {
      name: 'events_replay',
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

describe('events_replay', () => {
  it('is listed in the unbound profile with the sessionId + paging schema', async () => {
    const f = fixture();
    const tools = (await f.exchange('tools/list')).result.tools as Array<{
      name: string;
      inputSchema: { properties: Record<string, unknown>; required?: string[] };
    }>;
    const tool = tools.find((candidate) => candidate.name === 'events_replay');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties).toMatchObject({
      sessionId: { type: 'string', minLength: 1 },
      type: { type: 'string' },
      since: { type: 'integer', minimum: -1 },
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
      urlRegex: { type: 'string' },
      method: { type: 'string' },
      failedOnly: { type: 'boolean' },
    });
    expect(tool?.inputSchema.properties.stream).toBeDefined();
    expect(tool?.inputSchema.properties.statusClass).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(['sessionId']);
  });

  it('surfaces the eviction gap of a paged read', async () => {
    const f = fixture();
    f.events.mockResolvedValue({ events: [], nextCursor: 12, oldestSeq: 10, gap: true });
    const result = await f.call({ sessionId: 'ses_1', type: 'console.log', since: 3 });
    expect(result).toMatchObject({ nextCursor: 12, oldestSeq: 10, gap: true });
  });

  it('passes a type filter through and returns the paging envelope unpaged', async () => {
    const f = fixture();
    f.events.mockResolvedValue({
      events: [{ type: 'console.error', data: { text: 'boom' } }],
      nextCursor: -1,
    });
    const result = await f.call({ sessionId: 'ses_1', type: 'console.error' });
    expect(f.events).toHaveBeenCalledWith('ses_1', { type: 'console.error' });
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

  it('forwards request selectors without an explicit type or inferred stream', async () => {
    const f = fixture();
    f.events.mockResolvedValue({
      events: [],
      nextCursor: 9,
      oldestSeq: 7,
      gap: true,
      filter: { version: 1, stream: 'request' },
    });
    const selector = {
      urlRegex: 'api/(items|offers)',
      method: 'GET',
      statusClass: '4xx',
      failedOnly: true,
      since: -1,
      limit: 2,
    };
    expect(await f.call({ sessionId: 'ses_1', ...selector })).toMatchObject({
      events: [],
      nextCursor: 9,
      oldestSeq: 7,
      gap: true,
      filter: { version: 1, stream: 'request' },
    });
    expect(f.events).toHaveBeenCalledWith('ses_1', selector);
  });

  it('preserves explicit false rather than treating it as an omitted selector', async () => {
    const f = fixture();
    f.events.mockResolvedValue({
      events: [],
      nextCursor: 4,
      filter: { version: 1, stream: 'request' },
    });
    expect(await f.call({ sessionId: 'ses_1', failedOnly: false })).toMatchObject({
      filter: { version: 1, stream: 'request' },
    });
    expect(f.events).toHaveBeenCalledWith('ses_1', { failedOnly: false });
  });

  it('pages one selected other ledger without requiring an exact type', async () => {
    const f = fixture();
    f.events.mockResolvedValue({
      events: [],
      nextCursor: 4,
      filter: { version: 1, stream: 'other' },
    });
    await f.call({ sessionId: 'ses_1', stream: 'other', since: -1, limit: 5 });
    expect(f.events).toHaveBeenCalledWith('ses_1', { stream: 'other', since: -1, limit: 5 });
  });

  it.each([
    { stream: 'other', method: 'GET' },
    { type: 'console.log', statusClass: '5xx' },
    { method: 'get' },
    { failedOnly: 'false' },
    { urlRegex: 'λ'.repeat(129) },
    { type: '' },
    { type: 'request.failed', unknown: 'PRIVATE_SELECTOR_VALUE' },
  ])('rejects invalid selector arguments without invoking the client: %j', async (selector) => {
    const f = fixture();
    const response = await f.call({ sessionId: 'ses_1', ...selector });
    expect(response).toBeDefined();
    expect(f.events).not.toHaveBeenCalled();
  });

  it('retains the bound session identity with the same selector contract', async () => {
    const f = fixture({ sessionId: 'ses_bound', mode: 'bounty' });
    f.events.mockResolvedValue({
      events: [],
      nextCursor: 2,
      filter: { version: 1, stream: 'request' },
    });
    await f.call({ urlRegex: 'api', failedOnly: true });
    expect(f.events).toHaveBeenCalledWith('ses_bound', { urlRegex: 'api', failedOnly: true });
  });
});
