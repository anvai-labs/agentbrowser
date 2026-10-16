import { createHash } from 'node:crypto';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { buildServer, type ServerOptions } from './server.js';

const key = (value: string) => createHash('sha256').update(value).digest('hex');

it.each([
  ['disabled', {}, 'CDP_ATTACH_DISABLED', 'floor.cdp.disabled'],
  [
    'unacknowledged egress',
    { operatorCdp: { allowUnenforcedEgress: false } },
    'EGRESS_UNSUPPORTED',
    'floor.cdp.egress',
  ],
  [
    'hosted',
    { operatorCdp: { allowUnenforcedEgress: true }, deploymentMode: 'hosted' },
    'HOSTED_UNSUPPORTED',
    'floor.cdp.hosted',
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
    'floor.cdp.multi_tenant',
  ],
  [
    'remote listener',
    { operatorCdp: { allowUnenforcedEgress: true }, host: '0.0.0.0' },
    'CDP_ATTACH_LOCAL_ONLY',
    'floor.cdp.local_only',
  ],
] as const)('refuses %s before engine allocation', async (_name, options, reason, rule) => {
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
      // `reason` stays stable for clients; `rule` names the ADR-024 floor refusal.
      error: { code: 'ENGINE_UNSUPPORTED', details: { reason, rule } },
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
  // T10 M1: the attach lane is not scope-enforced, so a scope is refused, not ignored.
  { policy: { scope: { allowedHosts: ['example.com'] } } },
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

it.each([
  // Without operator credentials the delegated-session floor refuses first.
  ['delegated control', { controlMode: 'delegated' }, 'FORBIDDEN', 'floor.delegated.operator'],
  [
    'cookie seeding',
    { cookies: [{ name: 'a', value: 'b', domain: 'example.com', path: '/' }] },
    'INVALID_REQUEST',
    'floor.cdp.options',
  ],
] as const)(
  'refuses %s on an attached session as a floor rule',
  async (_name, extra, code, rule) => {
    const engine = new FakeEngine();
    const create = vi.spyOn(engine, 'createSession');
    const app = await buildServer({ engine });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: { tenantId: 'one', cdpAttach: true, ...extra },
      });
      expect(response.json()).toMatchObject({
        error: { code, details: { rule } },
      });
      expect(create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }
);

it('names the operator floor on operator-only routes of a keyless local service', async () => {
  // Without API keys there is no principal, so the operator check itself refuses.
  const app = await buildServer({ engine: new FakeEngine() });
  try {
    for (const [method, url] of [
      ['POST', '/v1/sessions/s1/control/takeover'],
      ['POST', '/v1/sessions/s1/control/delegate'],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: 'FORBIDDEN', details: { rule: 'floor.delegated.operator' } },
      });
    }
  } finally {
    await app.close();
  }
});
