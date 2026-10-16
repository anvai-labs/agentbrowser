/** T5 B-dur-2c: `executionRequirement` on the act, plan and autofill tools. */
import { beforeEach, expect, it, vi } from 'vitest';
import { buildMcpServer } from './mcp-server';

let sessions: Record<string, ReturnType<typeof vi.fn>>;
let server: ReturnType<typeof buildMcpServer>;
const call = async (name: string, args: Record<string, unknown>) =>
  JSON.parse(
    await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: name,
        method: 'tools/call',
        params: { name, arguments: args },
      })
    )
  ).result;

beforeEach(() => {
  sessions = {
    executeAction: vi.fn().mockResolvedValue({ status: 'success', actionId: 'a', newRevision: 2 }),
    plan: vi.fn().mockResolvedValue({ ok: true, completed: 1, results: [{ step: 0, ok: true }] }),
    autofill: vi.fn().mockResolvedValue({
      ok: true,
      receipts: [{ field: 0, status: 'verified', verified: true }],
    }),
  };
  server = buildMcpServer({
    createClient: vi.fn().mockReturnValue({ sessions }),
    serverInfo: { name: 'agentbrowser', version: '1.0.0' },
  });
});

it('advertises executionRequirement on exactly act, plan and autofill', async () => {
  const tools = JSON.parse(
    await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  ).result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
  const carrying = tools
    .filter((tool) => 'executionRequirement' in tool.inputSchema.properties)
    .map((tool) => tool.name)
    .sort();
  expect(carrying).toEqual(['act', 'autofill', 'plan']);
  expect(
    tools.find((tool) => tool.name === 'act')?.inputSchema.properties.executionRequirement
  ).toMatchObject({ enum: ['ephemeral', 'durable'] });
});

it('forwards it as the SDK mutation option, never inside the action body', async () => {
  const base = { sessionId: 'ses_1', pageId: 'pg_1', operationId: 'op-1' };
  await call('act', {
    ...base,
    action: 'scroll',
    direction: 'down',
    executionRequirement: 'durable',
  });
  expect(sessions.executeAction).toHaveBeenCalledWith(
    'ses_1',
    'pg_1',
    { action: 'scroll', direction: 'down' },
    { operationId: 'op-1', executionRequirement: 'durable' }
  );
  await call('plan', {
    ...base,
    actions: [{ action: 'scroll', direction: 'down' }],
    executionRequirement: 'durable',
  });
  expect(sessions.plan).toHaveBeenCalledWith('ses_1', 'pg_1', expect.any(Array), {
    operationId: 'op-1',
    executionRequirement: 'durable',
  });
  await call('autofill', {
    ...base,
    fields: [{ match: { label: 'Company' }, value: 'Acme' }],
    executionRequirement: 'ephemeral',
  });
  expect(sessions.autofill).toHaveBeenCalledWith('ses_1', 'pg_1', expect.any(Object), {
    operationId: 'op-1',
    executionRequirement: 'ephemeral',
  });
});

it('omitted leaves the call unchanged; another value is refused before any call', async () => {
  await call('act', { sessionId: 'ses_1', pageId: 'pg_1', action: 'scroll', direction: 'down' });
  expect(sessions.executeAction).toHaveBeenCalledWith('ses_1', 'pg_1', {
    action: 'scroll',
    direction: 'down',
  });
  sessions.executeAction.mockClear();
  const refused = await call('act', {
    sessionId: 'ses_1',
    pageId: 'pg_1',
    action: 'scroll',
    direction: 'down',
    executionRequirement: 'eventually',
  });
  expect(refused.isError).toBe(true);
  expect(sessions.executeAction).not.toHaveBeenCalled();
});
