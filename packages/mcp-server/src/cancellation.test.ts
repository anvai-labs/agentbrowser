/**
 * T0/T8 MCP cancellation (notifications/cancelled, MCP 2025-06-18 "Cancellation"):
 * the receiver stops the in-flight request, frees it, and sends no response for it. Races are
 * benign: a cancel for a finished or unknown request is ignored and never re-runs or rolls back.
 */
import { createServer } from 'node:http';
import { AgentBrowserClient } from '@agentbrowser/sdk-typescript';
import { describe, expect, it, vi } from 'vitest';
import type { McpClient } from './mcp-server';
import { buildMcpServer, INFLIGHT_COUNT } from './mcp-server';

function harness() {
  let signalOf: (() => AbortSignal | undefined) | undefined;
  const signalsSeen: AbortSignal[] = [];
  /** A call that runs until its request signal aborts (then fails as the SDK would). */
  const blocking = vi.fn(async () => {
    const signal = signalOf?.();
    if (signal === undefined) throw new Error('no request signal');
    signalsSeen.push(signal);
    await new Promise<void>((_, reject) =>
      signal.addEventListener('abort', () =>
        reject(
          Object.assign(new Error('Request cancelled; outcome may be unknown'), {
            code: 'CANCELLED',
            details: { operationId: 'op-1' },
          })
        )
      )
    );
  });
  const sessions = {
    observe: blocking,
    executeAction: blocking,
    snapshot: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      title: 'Example',
      revision: 1,
      mode: 'stable',
      fields: [],
    }),
  };
  const server = buildMcpServer({
    createClient: (options: { requestSignal?: () => AbortSignal | undefined }) => {
      signalOf = options.requestSignal;
      return { sessions } as unknown as McpClient;
    },
    serverInfo: { name: 'agentbrowser', version: '1.0.0' },
  } as never);
  const send = (message: object) => server.handle(JSON.stringify({ jsonrpc: '2.0', ...message }));
  const call = (id: number | string, name: string, args: Record<string, unknown>) =>
    send({ id, method: 'tools/call', params: { name, arguments: args } });
  const cancel = (requestId: number | string) =>
    send({ method: 'notifications/cancelled', params: { requestId, reason: 'user stopped' } });
  return { send, call, cancel, sessions, signalsSeen, blocking, server };
}

const tick = () => new Promise((settle) => setTimeout(settle, 10));

describe('MCP request cancellation', () => {
  it('a cancelled in-flight call aborts its request signal and gets no response', async () => {
    const h = harness();
    await h.send({ id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const pending = h.call(1, 'observe', { sessionId: 'ses_1', pageId: 'pg_1' });
    await tick();
    expect(h.signalsSeen).toHaveLength(1);
    expect(h.signalsSeen[0]?.aborted).toBe(false);
    expect(await h.cancel(1)).toBeNull();
    expect(h.signalsSeen[0]?.aborted).toBe(true);
    // MCP: the receiver sends no response for a cancelled request.
    expect(await pending).toBeNull();
  });

  it('a cancelled write (act) is abandoned without any success or replay answer', async () => {
    const h = harness();
    const pending = h.call('w1', 'act', {
      sessionId: 'ses_1',
      pageId: 'pg_1',
      action: 'click',
      target: { ref: 'e1_0' },
    });
    await tick();
    await h.cancel('w1');
    expect(await pending).toBeNull();
    expect(h.blocking).toHaveBeenCalledTimes(1);
  });

  it('cancelling one of two concurrent calls leaves the other untouched', async () => {
    const h = harness();
    const first = h.call(1, 'observe', { sessionId: 'ses_1', pageId: 'pg_1' });
    const second = h.call(2, 'observe', { sessionId: 'ses_1', pageId: 'pg_2' });
    await tick();
    expect(h.signalsSeen).toHaveLength(2);
    await h.cancel(2);
    expect(h.signalsSeen[0]?.aborted).toBe(false);
    expect(h.signalsSeen[1]?.aborted).toBe(true);
    expect(await second).toBeNull();
    // The first is still running; cancel it too so the test ends.
    await h.cancel(1);
    expect(await first).toBeNull();
  });

  it('a cancel after the response, or for an unknown id, is ignored and re-runs nothing', async () => {
    const h = harness();
    const done = JSON.parse(
      (await h.call(7, 'snapshot', { sessionId: 'ses_1', pageId: 'pg_1' })) ?? 'null'
    );
    expect(done.result.isError).toBeUndefined();
    expect(await h.cancel(7)).toBeNull();
    expect(await h.cancel('never-sent')).toBeNull();
    expect(h.sessions.snapshot).toHaveBeenCalledTimes(1);
  });

  it('a request id is not cancellable once its response has been produced', async () => {
    const h = harness();
    // Reusing an id for a new call after the old one finished: the cancel targets only the live one.
    await h.call(9, 'snapshot', { sessionId: 'ses_1', pageId: 'pg_1' });
    const live = h.call(9, 'observe', { sessionId: 'ses_1', pageId: 'pg_1' });
    await tick();
    await h.cancel(9);
    expect(await live).toBeNull();
  });

  it('initialize cannot be cancelled', async () => {
    const h = harness();
    const pending = h.send({ id: 'init', method: 'initialize', params: {} });
    await h.cancel('init');
    const response = JSON.parse((await pending) ?? 'null');
    expect(response.result.protocolVersion).toBeDefined();
  });

  it('end to end: cancelling a call abandons the real SDK request to the service', async () => {
    let started = 0;
    let abandoned = 0;
    const service = createServer((_request, response) => {
      started += 1;
      const timer = setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"status":"success","url":"https://example.com/","redirectChain":[]}');
      }, 5_000);
      response.on('close', () => {
        if (!response.writableEnded) abandoned += 1;
        clearTimeout(timer);
      });
    });
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
    const address = service.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    try {
      const server = buildMcpServer({
        createClient: (options) => new AgentBrowserClient(options) as unknown as McpClient,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
      const pending = server.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'nav-1',
          method: 'tools/call',
          params: {
            name: 'navigate',
            arguments: { sessionId: 'ses_1', pageId: 'pg_1', url: 'https://example.com/' },
          },
        })
      );
      await vi.waitFor(() => expect(started).toBe(1));
      await server.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 'nav-1' },
        })
      );
      expect(await pending).toBeNull();
      await vi.waitFor(() => expect(abandoned).toBe(1));
    } finally {
      service.closeAllConnections();
      await new Promise<void>((resolve) => service.close(() => resolve()));
    }
  });

  it('a cancelled create still frees the session it created (cleanup runs outside the cancel)', async () => {
    let signalOf: (() => AbortSignal | undefined) | undefined;
    const closeSignals: Array<AbortSignal | undefined> = [];
    const sessions = {
      create: vi.fn().mockResolvedValue({ sessionId: 'ses_new', status: 'ready' }),
      createPage: vi.fn(async () => {
        const signal = signalOf?.();
        await new Promise<void>((_, reject) =>
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }))
          )
        );
      }),
      close: vi.fn(async () => {
        closeSignals.push(signalOf?.());
      }),
    };
    const server = buildMcpServer({
      createClient: (options: { requestSignal?: () => AbortSignal | undefined }) => {
        signalOf = options.requestSignal;
        return { sessions } as unknown as McpClient;
      },
    } as never);
    const pending = server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'create-1',
        method: 'tools/call',
        params: { name: 'create', arguments: { tenantId: 't' } },
      })
    );
    await vi.waitFor(() => expect(sessions.createPage).toHaveBeenCalled());
    await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'create-1' },
      })
    );
    expect(await pending).toBeNull();
    expect(sessions.close).toHaveBeenCalledWith('ses_new');
    // The cleanup request carried no (cancelled) caller signal, so the SDK really sends it.
    expect(closeSignals).toEqual([undefined]);
  });

  it('two in-flight calls reusing one id: the first finishing does not unregister the second', async () => {
    const h = harness();
    let release!: () => void;
    h.sessions.snapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              url: 'https://example.com',
              title: 'x',
              revision: 1,
              mode: 'stable',
              fields: [],
            });
        })
    );
    const first = h.call(5, 'snapshot', { sessionId: 'ses_1', pageId: 'pg_1' });
    await tick();
    const second = h.call(5, 'observe', { sessionId: 'ses_1', pageId: 'pg_1' });
    await tick();
    release();
    expect(JSON.parse((await first) ?? 'null').result).toBeDefined();
    // The cancel must still reach the live second call.
    await h.cancel(5);
    expect(await second).toBeNull();
    expect(h.signalsSeen.at(-1)?.aborted).toBe(true);
  });

  it('the in-flight table drains after success, error and cancel', async () => {
    const h = harness();
    const server = h.server;
    await h.call(1, 'snapshot', { sessionId: 'ses_1', pageId: 'pg_1' });
    expect(server[INFLIGHT_COUNT]()).toBe(0);
    h.sessions.snapshot.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { code: 'NOT_FOUND' })
    );
    await h.call(2, 'snapshot', { sessionId: 'ses_1', pageId: 'pg_1' });
    expect(server[INFLIGHT_COUNT]()).toBe(0);
    const pending = h.call(3, 'observe', { sessionId: 'ses_1', pageId: 'pg_1' });
    await tick();
    expect(server[INFLIGHT_COUNT]()).toBe(1);
    await h.cancel(3);
    await pending;
    expect(server[INFLIGHT_COUNT]()).toBe(0);
  });
});
