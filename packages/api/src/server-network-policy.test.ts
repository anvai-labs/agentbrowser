import { NetworkPolicy } from '@agentbrowser/policy';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
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

// ADR-019: allowServiceWorkers travels nested under `policy` on the wire,
// same as allowedHosts/blockedHosts/allowDownloads, and must reach the
// engine's createSession call unchanged - off by default, explicit when set.
it('forwards policy.allowServiceWorkers through to the engine (ADR-019)', async () => {
  const engine = new FakeEngine();
  const createSession = vi.spyOn(engine, 'createSession');
  const server = await buildServer({ engine });
  try {
    await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'test', policy: { allowServiceWorkers: true } },
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ allowServiceWorkers: true })
    );
  } finally {
    await server.close();
  }
});

it('does not set allowServiceWorkers on the engine call when the session omits it', async () => {
  const engine = new FakeEngine();
  const createSession = vi.spyOn(engine, 'createSession');
  const server = await buildServer({ engine });
  try {
    await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'test' },
    });
    const options = createSession.mock.calls.at(-1)?.[0];
    expect(options?.allowServiceWorkers).toBeUndefined();
  } finally {
    await server.close();
  }
});
