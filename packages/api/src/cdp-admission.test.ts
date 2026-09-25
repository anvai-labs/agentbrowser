import { createHash } from 'node:crypto';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { type ServerOptions, buildServer } from './server.js';

const key = (value: string) => createHash('sha256').update(value).digest('hex');

it.each([
  ['disabled', {}, 'CDP_ATTACH_DISABLED'],
  [
    'unacknowledged egress',
    { operatorCdp: { allowUnenforcedEgress: false } },
    'EGRESS_UNSUPPORTED',
  ],
  [
    'hosted',
    { operatorCdp: { allowUnenforcedEgress: true }, deploymentMode: 'hosted' },
    'HOSTED_UNSUPPORTED',
  ],
  [
    'multiple tenants',
    {
      operatorCdp: { allowUnenforcedEgress: true },
      apiKeys: new Map([
        [key('a'), 'one'],
        [key('b'), 'two'],
      ]),
    },
    'HOSTED_UNSUPPORTED',
  ],
  [
    'remote listener',
    { operatorCdp: { allowUnenforcedEgress: true }, host: '0.0.0.0' },
    'CDP_ATTACH_LOCAL_ONLY',
  ],
] as const)('refuses %s before engine allocation', async (_name, options, reason) => {
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const app = await buildServer({ engine, ...options } as ServerOptions);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: 'apiKeys' in options ? { authorization: 'Bearer a' } : {},
      payload: { tenantId: 'one', cdpAttach: true },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'ENGINE_UNSUPPORTED', details: { reason } },
    });
    expect(create).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('ordinary sessions keep policy and never select attachment', async () => {
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const app = await buildServer({ engine });
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/sessions',
          payload: { tenantId: 'one', cdpAttach: false },
        })
      ).statusCode
    ).toBe(201);
    expect(create.mock.calls[0]?.[0].requestPolicy).toBeDefined();
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('cdpAttach', true);
  } finally {
    await app.close();
  }
});

it('does not let an unsupported adapter silently ignore attachment', async () => {
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const app = await buildServer({
    engine,
    apiKeys: new Map([[key('a'), 'one']]),
    operatorCdp: { allowUnenforcedEgress: true },
  } as ServerOptions);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: 'Bearer a' },
      payload: { tenantId: 'one', cdpAttach: true },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.reason).toBe('CDP_ATTACH_UNSUPPORTED');
    expect(create).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it.each([
  { controlMode: 'delegated' },
  { headless: false },
  { viewport: { width: 800, height: 600 } },
  { cookies: [] },
  { policy: { allowDownloads: true } },
  { policy: { allowedHosts: ['example.com'] } },
  { cdpEndpoint: 'http://192.168.1.89:9222' },
])('refuses incompatible or caller-controlled attachment options %j', async (extra) => {
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const app = await buildServer({
    engine,
    operatorCdp: { allowUnenforcedEgress: true },
  } as ServerOptions);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'one', cdpAttach: true, ...extra },
    });
    expect(response.statusCode).toBe('controlMode' in extra ? 403 : 400);
    expect(create).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('carries the selector and policy to a qualified adapter under a single trust domain', async () => {
  const engine = new FakeEngine();
  const caps = await engine.capabilities();
  vi.spyOn(engine, 'capabilities').mockResolvedValue({ ...caps, supportsCdpAttach: true });
  const create = vi.spyOn(engine, 'createSession');
  const app = await buildServer({
    engine,
    apiKeys: new Map([
      [key('a'), 'one'],
      [key('b'), 'one'],
    ]),
    operatorCdp: { allowUnenforcedEgress: true },
  } as ServerOptions);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: 'Bearer a' },
      payload: { tenantId: 'one', cdpAttach: true },
    });
    expect(response.statusCode).toBe(201);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ cdpAttach: true });
    const sessionId = response.json().sessionId;
    for (const request of [
      { method: 'GET' as const, url: `/v1/sessions/${sessionId}` },
      { method: 'POST' as const, url: `/v1/sessions/${sessionId}/pages`, payload: {} },
      {
        method: 'POST' as const,
        url: '/v1/sessions',
        payload: { tenantId: 'one', cdpAttach: true },
      },
    ])
      expect((await app.inject(request)).statusCode).toBe(401);

    expect(create.mock.calls[0]?.[0].requestPolicy).toBeDefined();
  } finally {
    await app.close();
  }
});

it('rejects a remote peer even if an embedding listens on a different address', async () => {
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const app = await buildServer({
    engine,
    operatorCdp: { allowUnenforcedEgress: true },
  } as ServerOptions);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      remoteAddress: '192.168.1.4',
      payload: { tenantId: 'one', cdpAttach: true },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.reason).toBe('CDP_ATTACH_LOCAL_ONLY');
    expect(create).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('rejects an embedding that binds its declared local service to a wildcard listener', async () => {
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const app = await buildServer({ engine, operatorCdp: { allowUnenforcedEgress: true } });
  vi.spyOn(app.server, 'address').mockReturnValue({
    address: '0.0.0.0',
    family: 'IPv4',
    port: 5709,
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'one', cdpAttach: true },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.reason).toBe('CDP_ATTACH_LOCAL_ONLY');
    expect(create).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await app.close();
  }
});

it('rejects delegated attachment even for an authenticated operator', async () => {
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const app = await buildServer({
    engine,
    apiKeys: new Map([[key('a'), 'one']]),
    operatorCdp: { allowUnenforcedEgress: true },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: 'Bearer a' },
      payload: { tenantId: 'one', cdpAttach: true, controlMode: 'delegated' },
    });
    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it.each([undefined, new Map<string, string>()])(
  'refuses profile attachment without independent bearer credentials',
  async (apiKeys) => {
    const engine = new FakeEngine();
    const caps = await engine.capabilities();
    vi.spyOn(engine, 'capabilities').mockResolvedValue({ ...caps, supportsCdpAttach: true });
    const create = vi.spyOn(engine, 'createSession');
    const app = await buildServer({
      engine,
      ...(apiKeys ? { apiKeys } : {}),
      operatorCdp: { allowUnenforcedEgress: true },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: { tenantId: 'one', cdpAttach: true },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.details.reason).toBe('CDP_ATTACH_AUTH_REQUIRED');
      expect(create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }
);
