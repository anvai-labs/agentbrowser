/** ADR-030 P0-2: the page_fetch tool's envelope handling. Envelope fields
 * (approvalToken, operationId, executionRequirement) travel outside the probe;
 * a review finding showed them leaking into the strict action union, which made
 * every approved or delegated page_fetch undispatchable. */
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
    executeAction: vi.fn().mockResolvedValue({
      status: 'success',
      actionId: 'probe-1',
      newRevision: 4,
      result: {
        status: 200,
        headers: [],
        body: '{"ok":true}',
        bodyBytes: 9,
        truncated: false,
        outcome: 'terminal',
        untrustedContent: true,
      },
    }),
  };
  server = buildMcpServer({
    createClient: vi.fn().mockReturnValue({ sessions }),
    serverInfo: { name: 'agentbrowser', version: '1.0.0' },
  });
});

it('dispatches an approved unsafe probe with the token in the envelope, never the body', async () => {
  const result = await call('page_fetch', {
    sessionId: 'ses_1',
    pageId: 'pg_1',
    method: 'PUT',
    url: 'https://vinted.test/api/items/4029603257',
    headers: [{ name: 'X-CSRF-Token', value: 'csrf-secret-0123456789' }],
    body: '{"price_cents":101}',
    approvalToken: 'tok-1',
  });
  expect(result.isError).toBeUndefined();
  expect(sessions.executeAction).toHaveBeenCalledWith('ses_1', 'pg_1', {
    action: 'fetch',
    method: 'PUT',
    url: 'https://vinted.test/api/items/4029603257',
    headers: [{ name: 'X-CSRF-Token', value: 'csrf-secret-0123456789' }],
    body: '{"price_cents":101}',
    approvalToken: 'tok-1',
  });
});

it('forwards a delegated operationId as the SDK option, not an action field', async () => {
  await call('page_fetch', {
    sessionId: 'ses_1',
    pageId: 'pg_1',
    method: 'GET',
    url: 'https://vinted.test/api/items/1',
    operationId: 'op-9',
    executionRequirement: 'durable',
  });
  expect(sessions.executeAction).toHaveBeenCalledWith(
    'ses_1',
    'pg_1',
    { action: 'fetch', method: 'GET', url: 'https://vinted.test/api/items/1' },
    { operationId: 'op-9', executionRequirement: 'durable' }
  );
});

it('refuses an invalid probe before any dispatch, naming the offending field', async () => {
  const refused = await call('page_fetch', {
    sessionId: 'ses_1',
    pageId: 'pg_1',
    method: 'TRACE',
    url: 'https://vinted.test/x',
  });
  expect(refused.isError).toBe(true);
  expect(sessions.executeAction).not.toHaveBeenCalled();
});

it('refuses a method-tunneling header through the tool schema path', async () => {
  const refused = await call('page_fetch', {
    sessionId: 'ses_1',
    pageId: 'pg_1',
    method: 'GET',
    url: 'https://vinted.test/api/items/1',
    headers: [{ name: 'X-HTTP-Method-Override', value: 'DELETE' }],
  });
  expect(refused.isError).toBe(true);
  expect(sessions.executeAction).not.toHaveBeenCalled();
});
