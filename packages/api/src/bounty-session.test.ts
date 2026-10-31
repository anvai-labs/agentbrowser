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

it('surfaces the validate-only binding hint at creation and status without leaking values', async () => {
  const engine = new FakeEngine();
  vi.spyOn(engine, 'capabilities').mockResolvedValue({
    ...(await engine.capabilities()),
    requestHeaderInjection: true,
  });
  const service = new AgentBrowserService({ engine });
  try {
    const identityBindings = [
      { header: 'X-HackerOne-Research', value: 'private-marker', allowedHosts: ['wolt.com'] },
    ];
    const session = await service.createSession({
      scope: { allowedHosts: ['wolt.com'], identityBindings },
    });
    expect(session.warnings?.join(' ')).toContain('does not inject');
    expect(service.getSession(session.sessionId)?.warnings).toEqual(session.warnings);
    expect(JSON.stringify(session)).not.toContain('private-marker');
    const injected = await service.createSession({
      scope: {
        allowedHosts: ['wolt.com'],
        identityBindings,
        requestHeaders: [{ header: 'X-HackerOne-Research', value: 'private-marker' }],
      },
    });
    expect(injected.warnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringContaining('does not inject')])
    );
  } finally {
    await service.shutdown();
  }
});
