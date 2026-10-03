import { NetworkPolicy } from '@agentbrowser/policy';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { buildServer } from './server';

it('captures the operator response cap at startup and enforces it through session host policy', async () => {
  const previous = process.env.AGENTBROWSER_MAX_RESPONSE_BYTES;
  process.env.AGENTBROWSER_MAX_RESPONSE_BYTES = '33554432';
  const engine = new FakeEngine();
  const createSession = vi.spyOn(engine, 'createSession');
  try {
    const server = await buildServer({ engine });
    try {
      // Later environment edits must not silently mutate a running service's policy.
      process.env.AGENTBROWSER_MAX_RESPONSE_BYTES = '67108864';
      const response = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: { tenantId: 'test', policy: { allowedHosts: ['www.linkedin.com'] } },
      });
      expect(response.statusCode).toBe(201);
      const policy = createSession.mock.calls.at(-1)?.[0].requestPolicy;
      expect(policy?.checkBodySize).toBeTypeOf('function');
      await expect(policy?.checkBodySize?.(33554432)).resolves.toBeUndefined();
      await expect(policy?.checkBodySize?.(33554433)).rejects.toThrow();
      await expect(
        policy?.checkRequest({ hostname: 'example.com', url: 'https://example.com/' })
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  } finally {
    if (previous === undefined) {
      // biome-ignore lint/performance/noDelete: restore an absent environment setting.
      delete process.env.AGENTBROWSER_MAX_RESPONSE_BYTES;
    } else process.env.AGENTBROWSER_MAX_RESPONSE_BYTES = previous;
  }
});

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

it('the operator loopback opt-in (env) allows loopback without injecting a policy', async () => {
  process.env.AGENTBROWSER_ALLOW_LOOPBACK = '1';
  try {
    const server = await buildServer({ engine: new FakeEngine() });
    try {
      const create = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: { tenantId: 'test', policy: { allowedHosts: ['127.0.0.1'] } },
      });
      const { sessionId } = create.json();
      const page = await server.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/pages` });
      const allowed = await server.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/pages/${page.json().pageId}/navigate`,
        payload: { url: 'http://127.0.0.1/' },
      });
      expect(allowed.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  } finally {
    // biome-ignore lint/performance/noDelete: env restore requires the delete.
    delete process.env.AGENTBROWSER_ALLOW_LOOPBACK;
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

// snapshotTimeoutMs travels top-level on the wire (a reliability/performance
// knob, not a SessionPolicy egress trade-off like allowServiceWorkers) and
// must reach the engine's createSession call unchanged.
it('forwards snapshotTimeoutMs through to the engine', async () => {
  const engine = new FakeEngine();
  const createSession = vi.spyOn(engine, 'createSession');
  const server = await buildServer({ engine });
  try {
    await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'test', snapshotTimeoutMs: 8000 },
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotTimeoutMs: 8000 })
    );
  } finally {
    await server.close();
  }
});

it('does not set snapshotTimeoutMs on the engine call when the session omits it', async () => {
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
    expect(options?.snapshotTimeoutMs).toBeUndefined();
  } finally {
    await server.close();
  }
});

it('rejects an out-of-range snapshotTimeoutMs before it reaches the engine', async () => {
  const engine = new FakeEngine();
  const createSession = vi.spyOn(engine, 'createSession');
  const server = await buildServer({ engine });
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'test', snapshotTimeoutMs: 30001 },
    });
    expect(response.statusCode).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});
