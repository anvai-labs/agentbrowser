import { createHash } from 'node:crypto';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it } from 'vitest';
import { buildServer } from './server.js';

it('keeps credentials, tenant authority and session/page addressing distinct for clients on one IP', async () => {
  const keys = [
    'synthetic-client-one-full-key',
    'synthetic-client-two-full-key',
    'synthetic-other-tenant-full-key',
  ];
  const server = await buildServer({
    engine: new FakeEngine(),
    apiKeys: new Map(
      keys.map((key, i) => [
        createHash('sha256').update(key).digest('hex'),
        i < 2 ? 'tenant-a' : 'tenant-b',
      ])
    ),
  });
  const headers = (key: string) => ({ authorization: `Bearer ${key}` });
  try {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      remoteAddress: '127.0.0.1',
      headers: headers(keys[0]!),
      payload: { tenantId: 'tenant-a' },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().sessionId;
    const path = `/v1/sessions/${sessionId}`;
    const page = await server.inject({
      method: 'POST',
      url: `${path}/pages`,
      headers: headers(keys[0]!),
    });
    expect(page.statusCode).toBe(201);
    const pageId = page.json().pageId;
    // Different credentials on the same network address do not identify a client
    // session; current credentials deliberately authorize their whole tenant.
    const peer = await server.inject({
      method: 'GET',
      url: path,
      remoteAddress: '127.0.0.1',
      headers: headers(keys[1]!),
    });
    expect(peer.statusCode).toBe(200);
    const other = await server.inject({
      method: 'GET',
      url: path,
      remoteAddress: '127.0.0.1',
      headers: headers(keys[2]!),
    });
    expect(other.statusCode).toBe(403);
    for (const invalid of [keys[0]!.slice(0, 12), sessionId, pageId]) {
      expect(
        (await server.inject({ method: 'GET', url: path, headers: headers(invalid) })).statusCode
      ).toBe(401);
    }
    const second = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: headers(keys[0]!),
      payload: { tenantId: 'tenant-a' },
    });
    const wrongSession = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${second.json().sessionId}/pages/${pageId}`,
      headers: headers(keys[0]!),
    });
    expect(wrongSession.statusCode).toBe(404);
  } finally {
    await server.close();
  }
});
