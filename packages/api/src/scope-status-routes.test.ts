// T10 M2: scope status and a dry-run check over REST (FakeEngine; no browser).
import { createHash } from 'node:crypto';
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');

async function harness() {
  const app = await buildServer({
    engine: new FakeEngine(),
    apiKeys: new Map([
      [keyHash('key-one'), 'one'],
      [keyHash('key-two'), 'two'],
    ]),
  });
  const call = (method: 'GET' | 'POST', url: string, key = 'key-one', payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${key}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  return { app, call };
}

describe('scope status and dry-run check (T10 M2)', () => {
  it('reports the scope in effect, budget and denials; never an identity value', async () => {
    const { app, call } = await harness();
    try {
      const created = await call('POST', '/v1/sessions', 'key-one', {
        tenantId: 'one',
        policy: {
          scope: {
            allowedHosts: ['in.example'],
            requestBudget: 5,
            identityBindings: [
              { header: 'x-id', value: 'secret-token', allowedHosts: ['in.example'] },
            ],
          },
        },
      });
      const { sessionId } = created.json();
      const status = await call('GET', `/v1/sessions/${sessionId}/scope`);
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        allowedHosts: ['in.example'],
        budget: { limit: 5, spent: 0, remaining: 5 },
        identityBindings: [{ header: 'x-id', allowedHosts: ['in.example'] }],
        expired: false,
        denials: {},
      });
      expect(status.body).not.toContain('secret-token');
    } finally {
      await app.close();
    }
  });

  it('dry-run check judges the rules without spending budget', async () => {
    const { app, call } = await harness();
    try {
      const { sessionId } = (
        await call('POST', '/v1/sessions', 'key-one', {
          tenantId: 'one',
          policy: { scope: { allowedHosts: ['in.example'], requestBudget: 1 } },
        })
      ).json();
      const base = `/v1/sessions/${sessionId}/scope/check`;
      const allowed = await call(
        'GET',
        `${base}?url=${encodeURIComponent('https://in.example/a')}`
      );
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual({ allowed: true });
      const denied = await call(
        'GET',
        `${base}?url=${encodeURIComponent('https://out.example/a')}&method=POST`
      );
      expect(denied.json()).toEqual({ allowed: false, scope: 'SCOPE_HOST_DENIED' });
      const status = (await call('GET', `/v1/sessions/${sessionId}/scope`)).json();
      expect(status.budget).toEqual({ limit: 1, spent: 0, remaining: 1 });
      expect(status.denials).toEqual({});
      for (const bad of ['', 'ftp://in.example/', 'not a url']) {
        const response = await call('GET', `${base}?url=${encodeURIComponent(bad)}`);
        expect(response.statusCode).toBe(400);
      }
      const good = encodeURIComponent('https://in.example/a');
      for (const method of ['', 'G-T', 'GET%20', 'GET&method=POST']) {
        const response = await call('GET', `${base}?url=${good}&method=${method}`);
        expect(response.statusCode, method).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it('is 404 without a scope and refuses another tenant', async () => {
    const { app, call } = await harness();
    try {
      const plain = (await call('POST', '/v1/sessions', 'key-one', { tenantId: 'one' })).json();
      const none = await call('GET', `/v1/sessions/${plain.sessionId}/scope`);
      expect(none.statusCode).toBe(404);
      expect(none.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      const scoped = (
        await call('POST', '/v1/sessions', 'key-one', {
          tenantId: 'one',
          policy: { scope: { allowedHosts: ['in.example'] } },
        })
      ).json();
      const other = await call('GET', `/v1/sessions/${scoped.sessionId}/scope`, 'key-two');
      expect([403, 404]).toContain(other.statusCode);
      expect(other.body).not.toContain('in.example');
      const otherCheck = await call(
        'GET',
        `/v1/sessions/${scoped.sessionId}/scope/check?url=${encodeURIComponent('https://in.example/')}`,
        'key-two'
      );
      expect([403, 404]).toContain(otherCheck.statusCode);
      expect(otherCheck.body).not.toContain('allowed');
    } finally {
      await app.close();
    }
  });
});

describe('scope status contract (ADR-015)', () => {
  it('the policy status validates against the protocol schema, budget and denials included', async () => {
    const { EngagementScopeStatusSchema, isValid } = await import('@agentbrowser/protocol');
    const { EngagementScopePolicy, NetworkPolicy } = await import('@agentbrowser/policy');
    const scope = new EngagementScopePolicy(new NetworkPolicy({ blockLoopback: false }), {
      allowedHosts: ['in.example'],
      pathRules: [{ prefix: '/api' }],
      allowedMethods: ['GET'],
      expiresAt: Date.now() + 60_000,
      requestBudget: 2,
      identityBindings: [{ header: 'x-id', value: 'v', allowedHosts: ['in.example'] }],
    });
    await scope
      .checkRequest({ hostname: 'out.example', url: 'http://out.example/' })
      .catch(() => {});
    const status = scope.status();
    expect(status.denials).toEqual({ SCOPE_HOST_DENIED: 1 });
    expect(isValid(EngagementScopeStatusSchema, status)).toBe(true);
    // The schema is closed: a status carrying a marker value would not validate.
    expect(
      isValid(EngagementScopeStatusSchema, {
        ...status,
        identityBindings: [{ header: 'x-id', value: 'v', allowedHosts: ['in.example'] }],
      })
    ).toBe(false);
  });

  // A scope may only narrow: a field this server cannot enforce must be refused,
  // never ignored (an ignored exclusion silently widens the engagement).
  it.each([
    ['top level', { allowedHosts: ['in.example'], excludeHosts: ['admin.in.example'] }],
    ['path rule', { allowedHosts: ['in.example'], pathRules: [{ prefix: '/api', exclude: true }] }],
    [
      'identity binding',
      {
        allowedHosts: ['in.example'],
        identityBindings: [
          { header: 'x-id', value: 'v', allowedHosts: ['in.example'], scope: 'x' },
        ],
      },
    ],
  ])('refuses an unknown scope field (%s) instead of ignoring it', async (_where, scope) => {
    const { app, call } = await harness();
    try {
      const created = await call('POST', '/v1/sessions', 'key-one', {
        tenantId: 'one',
        policy: { scope },
      });
      expect(created.statusCode).toBe(400);
      expect((await call('GET', '/v1/sessions')).json().sessions ?? []).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('still accepts every known scope field', async () => {
    const { app, call } = await harness();
    try {
      const created = await call('POST', '/v1/sessions', 'key-one', {
        tenantId: 'one',
        policy: {
          scope: {
            allowedHosts: ['in.example', '.in.example'],
            pathRules: [{ hostSuffix: 'in.example', prefix: '/api' }],
            allowedMethods: ['GET'],
            expiresAt: Date.now() + 60_000,
            requestBudget: 10,
            identityBindings: [{ header: 'x-id', value: 'v', allowedHosts: ['in.example'] }],
          },
        },
      });
      expect(created.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });
});
