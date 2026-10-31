import { createHash } from 'node:crypto';
import { AgentBrowserClient } from '@agentbrowser/sdk-typescript';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

it('streams authenticated denials immediately, refuses another tenant, and closes on cancellation', async () => {
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const server = await buildServer({
    engine,
    apiKeys: new Map([
      [hash('one-key'), 'one'],
      [hash('two-key'), 'two'],
    ]),
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const client = new AgentBrowserClient({
    baseUrl: `http://127.0.0.1:${(server.server.address() as { port: number }).port}`,
    apiKey: 'one-key',
  });
  const cancel = new AbortController();
  try {
    const session = await client.sessions.create({
      mode: 'bounty',
      policy: { scope: { allowedHosts: ['vinted.com'] } },
    });
    const forbidden = await server.inject({
      url: `/v1/sessions/${session.sessionId}/scope/trace`,
      headers: { authorization: 'Bearer two-key' },
    });
    expect(forbidden.statusCode).toBe(403);
    let ready = false;
    let failed: unknown;
    const iterator = client.sessions.traceDenials(session.sessionId, {
      signal: cancel.signal,
      onReady: () => {
        ready = true;
      },
    });
    const next = iterator.next();
    void next.catch((error) => {
      failed = error;
    });
    await expect.poll(() => failed ?? ready, { timeout: 5000 }).toBe(true);
    create.mock.calls[0]![0]!.requestRecorder!({
      type: 'request.failed',
      timestamp: new Date().toISOString(),
      data: {
        method: 'PUT',
        url: 'https://vinted.com/verify?code=private',
        scope: 'SCOPE_METHOD_DENIED',
      },
    });
    expect((await next).value).toMatchObject({
      type: 'scope.denied',
      data: { method: 'PUT', scope: 'SCOPE_METHOD_DENIED', url: 'https://vinted.com/verify' },
    });
    cancel.abort();
    await iterator.return();
  } finally {
    cancel.abort();
    await server.close();
  }
});
