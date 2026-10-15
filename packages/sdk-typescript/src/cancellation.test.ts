import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentBrowserClient } from './client.js';

/** T0/T8 cancellation: a caller-cancelled request is uncertain, never a success or a replay. */
let server: Server | undefined;
let requests = 0;
let closedEarly = 0;

async function slowServer(): Promise<string> {
  requests = 0;
  closedEarly = 0;
  server = createServer((_request, response) => {
    requests += 1;
    const timer = setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"status":"success"}');
    }, 2_000);
    response.on('close', () => {
      if (!response.writableEnded) closedEarly += 1;
      clearTimeout(timer);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('caller cancellation (requestSignal)', () => {
  it('aborts an in-flight write as CANCELLED with its operationId, not TIMEOUT, not retryable', async () => {
    const baseUrl = await slowServer();
    const controller = new AbortController();
    const client = new AgentBrowserClient({ baseUrl, requestSignal: () => controller.signal });
    const pending = client.sessions.navigate(
      'ses_1',
      'pg_1',
      { url: 'https://example.com/' },
      { operationId: 'op-cancel-1' }
    );
    await new Promise((settle) => setTimeout(settle, 100));
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'CANCELLED',
      retryable: false,
      details: { operationId: 'op-cancel-1' },
    });
    expect((error as Error).message).toMatch(/outcome may be unknown/);
    // The HTTP request was actually abandoned, not left running to completion.
    await new Promise((settle) => setTimeout(settle, 100));
    expect(closedEarly).toBe(1);
  });

  it('an already-cancelled signal sends nothing', async () => {
    const baseUrl = await slowServer();
    const controller = new AbortController();
    controller.abort();
    const client = new AgentBrowserClient({ baseUrl, requestSignal: () => controller.signal });
    await expect(client.sessions.get('ses_1')).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(requests).toBe(0);
  });

  it('without a signal the request completes as before', async () => {
    const baseUrl = await slowServer();
    const client = new AgentBrowserClient({ baseUrl, requestSignal: () => undefined });
    await expect(client.sessions.get('ses_1')).resolves.toMatchObject({ status: 'success' });
  }, 10_000);
});
