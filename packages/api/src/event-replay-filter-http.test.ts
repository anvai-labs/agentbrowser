import { createHash } from 'node:crypto';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it } from 'vitest';
import { buildServer } from './server.js';
import type { AgentBrowserService } from './service.js';

const key = (input: string) => createHash('sha256').update(input).digest('hex');

it('strictly decodes replay queries after tenant ownership and preserves legacy HTTP responses', async () => {
  const server = await buildServer({
    engine: new FakeEngine(),
    apiKeys: new Map([
      [key('owner-key'), 'owner'],
      [key('other-key'), 'other'],
    ]),
  });
  const service = (server as unknown as { service: AgentBrowserService }).service;
  const { sessionId } = await service.createSession({ tenantId: 'owner' });
  try {
    const path = `/v1/sessions/${sessionId}/events/replay`;
    const request = (query: string, token = 'owner-key') =>
      server.inject({
        method: 'GET',
        url: `${path}${query}`,
        headers: { authorization: `Bearer ${token}` },
      });
    const legacy = await request('');
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toEqual({ events: [], nextCursor: -1 });
    const filtered = await request('?failedOnly=false');
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toEqual({
      events: [],
      nextCursor: -1,
      oldestSeq: 0,
      gap: false,
      filter: { version: 1, stream: 'request' },
    });
    for (const query of [
      '?stream=request&stream=other',
      '?stream=request&limit=1&limit=2',
      '?stream=request&since=01',
      '?stream=request&since=1.0',
      '?stream=request&since=1e2',
      '?stream=request&since=+1',
      '?stream=request&since=-0',
      '?stream=request&limit=0',
      '?stream=request&limit=1001',
      '?stream=request&since=9007199254740992',
      '?failedOnly=1',
      '?failedOnly=TRUE',
      '?method=get',
      '?extra=ignored',
      '?stream=other&statusClass=4xx',
      '?stream=request&type=console.log',
      '?stream=request&urlRegex=%28%3F%3Dlookahead%29',
    ]) {
      const response = await request(query);
      expect(response.statusCode, query).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    }
    // Invalid regex must not expose another tenant's session or compile before ownership.
    expect((await request('?urlRegex=%5B', 'other-key')).statusCode).toBe(403);
    expect((await request('?urlRegex=%5B', 'bad-key')).statusCode).toBe(401);
  } finally {
    await server.close();
  }
});

it('keeps authenticated operator replay usable during human-controlled sessions', async () => {
  const server = await buildServer({
    engine: new FakeEngine(),
    apiKeys: new Map([[key('owner-key'), 'owner']]),
  });
  const service = (server as unknown as { service: AgentBrowserService }).service;
  const { sessionId } = await service.createSession({
    tenantId: 'owner',
    controlMode: 'delegated',
  });
  try {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/events/replay?stream=request`,
      headers: { authorization: 'Bearer owner-key' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ filter: { version: 1, stream: 'request' } });
  } finally {
    await server.close();
  }
});
