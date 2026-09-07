import { NetworkPolicy } from '@agentbrowser/policy';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it } from 'vitest';
import { buildServer } from './server';

it('allows trusted embedded policy injection while session host rules can only restrict it', async () => {
  const server = await buildServer({
    engine: new FakeEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false }),
  });
  try {
    const create = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'test', policy: { allowedHosts: ['127.0.0.1'] } },
    });
    const { sessionId } = create.json();
    const page = await server.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/pages` });
    const path = `/v1/sessions/${sessionId}/pages/${page.json().pageId}/navigate`;
    const allowed = await server.inject({
      method: 'POST',
      url: path,
      payload: { url: 'http://127.0.0.1/' },
    });
    expect(allowed.statusCode).toBe(200);
    const denied = await server.inject({
      method: 'POST',
      url: path,
      payload: { url: 'http://127.0.0.2/' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('POLICY_DENIED');
  } finally {
    await server.close();
  }
});

it('keeps private-address denial when no trusted policy is injected', async () => {
  const server = await buildServer({ engine: new FakeEngine() });
  try {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'test', policy: { allowedHosts: ['127.0.0.1'] } },
    });
    const { sessionId } = created.json();
    const page = await server.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/pages` });
    const denied = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/pages/${page.json().pageId}/navigate`,
      payload: { url: 'http://127.0.0.1/' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('POLICY_DENIED');
  } finally {
    await server.close();
  }
});
