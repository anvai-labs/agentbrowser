// T10 M1: a scoped session refuses the lanes the scope cannot check, instead
// of creating a session whose traffic partly escapes it.
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

describe('a scope refuses lanes it cannot check (T10 M1)', () => {
  it('refuses service workers with a scope: their fetches bypass the choke point', async () => {
    const engine = new FakeEngine();
    const create = vi.spyOn(engine, 'createSession');
    const app = await buildServer({ engine });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: {
          tenantId: 'one',
          policy: { allowServiceWorkers: true, scope: { allowedHosts: ['example.com'] } },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'INVALID_REQUEST', details: { rule: 'scope.lane.serviceWorkers' } },
      });
      expect(create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('still creates a scoped session with service workers blocked (the default)', async () => {
    const engine = new FakeEngine();
    const app = await buildServer({ engine });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: { tenantId: 'one', policy: { scope: { allowedHosts: ['example.com'] } } },
      });
      expect(response.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });
});
