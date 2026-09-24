/**
 * SPA-capture robustness surface on the MCP server:
 *  - browser_observe / browser_screenshot forward an optional `wait`
 *  - browser_create warns when a headed session has no reachable display
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Force display detection to "unavailable" so the headed-warning branch is
// exercised deterministically regardless of the host platform.
vi.mock('@agentbrowser/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentbrowser/protocol')>();
  return {
    ...actual,
    detectDisplayAvailability: () => ({
      available: false,
      reason: 'macos-launchd-no-aqua-session',
    }),
  };
});

import { buildMcpServer } from './mcp-server';
import type { McpClient, McpDependencies } from './mcp-server';

describe('MCP SPA-capture surface', () => {
  let sessions: Record<string, ReturnType<typeof vi.fn>>;
  let server: ReturnType<typeof buildMcpServer>;

  const call = (id: string, name: string, args: Record<string, unknown>) =>
    server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      })
    );

  const textOf = (response: unknown) => {
    const envelope = (typeof response === 'string' ? JSON.parse(response) : response) as {
      result: { content: { text: string }[] };
    };
    return JSON.parse(envelope.result.content[0].text);
  };

  beforeEach(() => {
    sessions = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'ses_1',
        status: 'ready',
        createdAt: '2026-08-23T10:00:00Z',
      }),
      createPage: vi
        .fn()
        .mockResolvedValue({ pageId: 'pg_1', sessionId: 'ses_1', status: 'ready' }),
      observe: vi.fn().mockResolvedValue({
        sessionId: 'ses_1',
        pageId: 'pg_1',
        revision: 1,
        url: 'https://example.com',
        title: 'Example',
        status: 'interactive',
        elements: [],
        truncated: false,
        untrustedContent: true,
      }),
      screenshot: vi.fn().mockResolvedValue({
        artifactId: 'art_1',
        type: 'screenshot',
        contentType: 'image/png',
        sizeBytes: 2048,
        url: '/sessions/ses_1/artifacts/art_1',
      }),
    };
    const deps: McpDependencies = {
      createClient: vi
        .fn()
        .mockReturnValue({ sessions: sessions as unknown as McpClient['sessions'] }),
      serverInfo: { name: 'agentbrowser', version: '1.0.0' },
    };
    server = buildMcpServer(deps);
  });

  it('browser_observe forwards a valid wait condition to the client', async () => {
    await call('1', 'browser_observe', {
      sessionId: 'ses_1',
      pageId: 'pg_1',
      wait: { until: 'networkidle', timeoutMs: 8000 },
    });
    expect(sessions.observe).toHaveBeenCalledWith(
      'ses_1',
      'pg_1',
      expect.objectContaining({ wait: { until: 'networkidle', timeoutMs: 8000 } })
    );
  });

  it('browser_observe omits wait when the until value is unknown', async () => {
    await call('2', 'browser_observe', {
      sessionId: 'ses_1',
      pageId: 'pg_1',
      wait: { until: 'bogus' },
    });
    const request = sessions.observe.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(request.wait).toBeUndefined();
  });

  it('browser_screenshot forwards a selectorVisible wait', async () => {
    await call('3', 'browser_screenshot', {
      sessionId: 'ses_1',
      pageId: 'pg_1',
      wait: { until: 'selectorVisible', selector: '#root [data-loaded]' },
    });
    expect(sessions.screenshot).toHaveBeenCalledWith(
      'ses_1',
      'pg_1',
      expect.objectContaining({
        wait: { until: 'selectorVisible', selector: '#root [data-loaded]' },
      })
    );
  });

  it('browser_create warns when a headed session has no reachable display', async () => {
    const result = textOf(
      await call('4', 'browser_create', { tenantId: 't1', headless: false })
    ) as {
      warnings?: string[];
    };
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings?.[0]).toMatch(/no display detected/i);
  });

  it('browser_create does not warn for a headless session', async () => {
    const result = textOf(
      await call('5', 'browser_create', { tenantId: 't1', headless: true })
    ) as {
      warnings?: string[];
    };
    expect(result.warnings).toBeUndefined();
  });
});
