import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { AgentBrowserService } from './service.js';

it('accepts research identity on REST and forwards the validated options', async () => {
  const engine = new FakeEngine();
  const caps = await engine.capabilities();
  vi.spyOn(engine, 'capabilities').mockResolvedValue({
    ...caps,
    requestHeaderInjection: true,
    userAgentOverride: true,
  });
  const create = vi.spyOn(engine, 'createSession');
  const app = await buildServer({ engine });
  try {
    const result = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: {
        tenantId: 'research',
        userAgent: 'ResearchBrowser username',
        policy: {
          scope: {
            allowedHosts: ['.wolt.com'],
            requestHeaders: [
              { header: 'X-HackerOne-Research', value: 'username', hostSuffix: '.wolt.com' },
            ],
          },
        },
      },
    });
    expect(result.statusCode).toBe(201);
    expect(result.json().userAgent).toBe('ResearchBrowser username');
    expect(create.mock.calls[0]?.[0]?.userAgent).toBe('ResearchBrowser username');
  } finally {
    await app.close();
  }
});

it.each([
  [{ header: 'Host', value: 'x' }],
  [{ header: 'X-Forwarded-For', value: 'x' }],
  [{ header: 'X-Research', value: 'a\r\nb' }],
  [{ header: 'X-Research', value: 'x', unknown: true }],
  [
    { header: 'X-Research', value: 'x' },
    { header: 'x-research', value: 'y' },
  ],
])(
  'refuses invalid request-header configuration on REST and in-process: %j',
  async (...requestHeaders) => {
    // each table row is the array itself; Vitest spreads row entries.
    const engine = new FakeEngine();
    const create = vi.spyOn(engine, 'createSession');
    const app = await buildServer({ engine });
    const scope = { allowedHosts: ['example.com'], requestHeaders };
    try {
      const result = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: { tenantId: 'research', policy: { scope } },
      });
      expect(result.statusCode).toBe(400);
      expect(create).not.toHaveBeenCalled();
      const service = new AgentBrowserService({ engine });
      try {
        await expect(service.createSession({ scope })).rejects.toMatchObject({
          code: 'INVALID_REQUEST',
        });
      } finally {
        await service.shutdown();
      }
    } finally {
      await app.close();
    }
  }
);

it('refuses identity overrides on an engine that cannot honor them and refuses unsupported lanes', async () => {
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const service = new AgentBrowserService({ engine });
  try {
    await expect(
      service.createSession({
        scope: {
          allowedHosts: ['example.com'],
          requestHeaders: [{ header: 'X-Research', value: 'x' }],
        },
      })
    ).rejects.toMatchObject({ details: { rule: 'scope.requestHeaders.engine' } });
    await expect(service.createSession({ userAgent: 'ResearchBrowser' })).rejects.toMatchObject({
      details: { rule: 'scope.userAgent.engine' },
    });
    await expect(service.createSession({ userAgent: 'x\ny' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(
      service.createSession({ userAgent: 'ResearchBrowser', allowDownloads: true })
    ).rejects.toMatchObject({ details: { rule: 'scope.identity.downloads' } });
    await expect(
      service.createSession({ userAgent: 'ResearchBrowser', cdpAttach: true })
    ).rejects.toMatchObject({ details: { rule: 'floor.cdp.options' } });
    expect(create).not.toHaveBeenCalled();
  } finally {
    await service.shutdown();
  }
});
