/**
 * TD-BROWSER-16 phase 7 (ADR-025 §6): the cookie_handoff MCP tool — profile
 * fencing, the bound-session drop, and the APPROVAL_REQUIRED relay the agent
 * forwards to the human operator (counts only, never values).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpDependencies } from './mcp-server';
import { buildMcpServer } from './mcp-server';

describe('the cookie_handoff tool (TD-BROWSER-16 phase 7)', () => {
  let sessions: Record<string, ReturnType<typeof vi.fn>>;
  let deps: McpDependencies;
  let server: ReturnType<typeof buildMcpServer>;

  const exchange = async (payload: unknown) =>
    JSON.parse(await server.handle(JSON.stringify(payload))) as {
      result?: { tools?: Array<{ name: string }>; content?: { text: string }[] };
      error?: { message: string };
    };
  const listTools = () =>
    exchange({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
  const call = (args: Record<string, unknown>) =>
    exchange({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'cookie_handoff', arguments: args },
    });
  const textOf = (response: NonNullable<unknown>) =>
    JSON.parse((response as { result: { content: { text: string }[] } }).result.content[0].text);

  beforeEach(() => {
    sessions = {
      create: vi.fn().mockResolvedValue({ sessionId: 'ses_1' }),
      close: vi.fn().mockResolvedValue(undefined),
      cookies: vi.fn().mockResolvedValue([]),
      plan: vi.fn().mockResolvedValue({ ok: true }),
      snapshot: vi.fn().mockResolvedValue({ fields: [] }),
      createPage: vi.fn().mockResolvedValue({ pageId: 'pg_1' }),
      navigate: vi.fn().mockResolvedValue({ status: 'success' }),
      observe: vi.fn().mockResolvedValue({ fields: [] }),
      executeAction: vi.fn().mockResolvedValue({ ok: true }),
      screenshot: vi.fn().mockResolvedValue({ artifactId: 'a' }),
      extract: vi.fn().mockResolvedValue({}),
      pdf: vi.fn().mockResolvedValue({ artifactId: 'a' }),
      html: vi.fn().mockResolvedValue({ artifactId: 'a' }),
      artifact: vi.fn().mockResolvedValue({}),
      events: vi.fn().mockResolvedValue({ events: [] }),
      cookieHandoff: vi.fn(),
    };
    deps = {
      createClient: vi.fn().mockReturnValue({ sessions }),
      serverInfo: { name: 'agentbrowser', version: '1.0.0' },
    };
    server = buildMcpServer(deps);
  });

  it('appears for browser profiles and never for the application mode', async () => {
    const qa = (await listTools()).result?.tools?.map((tool) => tool.name) ?? [];
    expect(qa).toContain('cookie_handoff');
    // Mode is a server construction input (AGENTBROWSER_MODE), not per request.
    deps = {
      createClient: vi.fn().mockReturnValue({ sessions }),
      serverInfo: { name: 'agentbrowser', version: '1.0.0' },
      mode: 'application',
    };
    server = buildMcpServer(deps);
    const application = (await listTools()).result?.tools?.map((tool) => tool.name) ?? [];
    expect(application).not.toContain('cookie_handoff');
  });

  it('is dropped when a session is bound (a bound session is never a handoff target)', async () => {
    const unbound = (await listTools()).result?.tools?.map((tool) => tool.name) ?? [];
    expect(unbound).toContain('cookie_handoff');
    deps = {
      createClient: vi.fn().mockReturnValue({ sessions }),
      serverInfo: { name: 'agentbrowser', version: '1.0.0' },
      sessionId: 'ses_1',
    };
    server = buildMcpServer(deps);
    const bound = (await listTools()).result?.tools?.map((tool) => tool.name) ?? [];
    expect(bound).not.toContain('cookie_handoff');
  });

  it('relays APPROVAL_REQUIRED as a structured result: token, domains, counts — never values', async () => {
    sessions.cookieHandoff.mockRejectedValue({
      code: 'APPROVAL_REQUIRED',
      message: 'The cookie handoff needs an explicit operator decision.',
      retryable: false,
      details: {
        tokenId: 'tok_1',
        kind: 'cookie.handoff',
        sessionId: 'ses_1',
        domains: ['example.com'],
        counts: { cookies: 3, 'example.com': 3 },
      },
    });
    const result = textOf(await call({ sessionId: 'ses_1', domains: ['example.com'] })) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      approvalRequired: true,
      tokenId: 'tok_1',
      domains: ['example.com'],
      counts: { cookies: 3, 'example.com': 3 },
    });
    expect(JSON.stringify(result)).not.toContain('value');
  });

  it('returns the completed handoff and passes the approval token through', async () => {
    sessions.cookieHandoff.mockResolvedValue({
      sessionId: 'ses_1',
      credentialSource: 'operator',
      domains: ['example.com'],
      counts: { cookies: 3, 'example.com': 3 },
    });
    const result = textOf(
      await call({ sessionId: 'ses_1', domains: ['example.com'], approvalToken: 'tok_1' })
    ) as Record<string, unknown>;
    expect(result).toMatchObject({ credentialSource: 'operator' });
    expect(sessions.cookieHandoff).toHaveBeenCalledWith('ses_1', {
      domains: ['example.com'],
      approvalToken: 'tok_1',
    });
  });

  it('refuses malformed domain lists with a usage error', async () => {
    const response = await call({ sessionId: 'ses_1', domains: [] });
    const text = JSON.stringify(response);
    expect(text).toMatch(/domains must be 1-16/);
    expect(sessions.cookieHandoff).not.toHaveBeenCalled();
  });
});
