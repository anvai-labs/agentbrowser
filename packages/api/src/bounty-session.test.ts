import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { AgentBrowserService } from './service.js';

afterEach(() => vi.unstubAllEnvs());

it('applies bounty presets at the service while preserving explicit stricter scope rate', async () => {
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const service = new AgentBrowserService({ engine });
  try {
    const session = await service.createSession({
      mode: 'bounty',
      scope: { allowedHosts: ['app.test'], rateLimit: { requests: 1, perSeconds: 4 } },
    });
    expect(session).toMatchObject({ ttlMs: 14400000, idleTimeoutMs: 3600000 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ headless: false }));
    expect(service.getScopeStatus(session.sessionId).rateLimit).toMatchObject({
      requests: 1,
      perSeconds: 4,
    });
  } finally {
    await service.shutdown();
  }
});

it('applies the environment preset on REST and refuses unknown request modes', async () => {
  vi.stubEnv('AGENTBROWSER_MODE', 'bounty');
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const server = await buildServer({ engine, defaultIdleTimeoutMs: 10000 });
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 't1' },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ ttlMs: 14400000, idleTimeoutMs: 10000 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ headless: false }));
    const bad = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { mode: 'invented' },
    });
    expect(bad.statusCode).toBe(400);
  } finally {
    await server.close();
  }
});
