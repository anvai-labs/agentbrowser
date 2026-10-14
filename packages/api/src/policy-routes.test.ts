import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicyFile } from '@agentbrowser/policy-engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startServer } from './server.js';

/**
 * TD-BROWSER-15 phase 5: the query routes. GET /v1/policy summarizes for a
 * default session of the caller's tenant and says so; POST /v1/policy/check
 * answers by enumeration — a resolver spy proves it never resolves; both are
 * rate-limited per tenant.
 */

let dir: string;
let app: Awaited<ReturnType<typeof startServer>>;
let policyApp: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'policy-routes-'));
  app = await startServer({ engine: new FakeEngine(), port: 0 });
  const path = join(dir, 'policy.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 'agentbrowser-policy/v1',
      unknownRisk: 'allow',
      approvalRules: [],
      policies: [
        {
          key: 'operator.loopback#1',
          ruleId: 'operator.loopback',
          cedar:
            '@rule("operator.loopback") permit(principal, action == AgentBrowser::Action::"request.loopback", resource) when { principal in AgentBrowser::Tenant::"local" };',
        },
      ],
    })
  );
  const loaded = await loadPolicyFile(path, { apiKeysConfigured: false });
  policyApp = await startServer({
    engine: new FakeEngine(),
    policy: {
      authorizer: loaded.authorizer,
      version: loaded.authorizer.version,
      limits: { extractMaxBytes: 4096 },
    },
    port: 0,
  });
});
afterAll(async () => {
  await app.close();
  await policyApp.close();
  await rm(dir, { recursive: true, force: true });
});

describe('GET /v1/policy', () => {
  it('summarizes capabilities for a default session of the caller tenant and says so', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/policy' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      policyVersion: string;
      summaryFor: string;
      capabilities: Record<string, { allowed: boolean; ruleMatched: string }>;
      unconditional: string;
    };
    expect(body.summaryFor).toBe("a default session of the caller's tenant");
    expect(body.unconditional).toMatch(/no policy file is loaded/);
    expect(Object.keys(body.capabilities)).toEqual([
      'cdp.attach',
      'downloads',
      'serviceWorkers',
      'cookie.seed',
      'cookie.export',
      'session.headed',
    ]);
    expect(body.capabilities.downloads?.allowed).toBe(true);
  });
  it('with a policy file: the version, the limits, no unconditional note', async () => {
    const response = await policyApp.inject({ method: 'GET', url: '/v1/policy' });
    const body = response.json() as {
      policyVersion: string;
      limits: { extractMaxBytes?: number };
      unconditional?: string;
    };
    expect(body.policyVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(body.limits.extractMaxBytes).toBe(4096);
    expect(body.unconditional).toBeUndefined();
  });
});

describe('POST /v1/policy/check', () => {
  it('never resolves: the resolver spy sees nothing', async () => {
    const spy = vi
      .spyOn(require('node:dns').promises, 'lookup')
      .mockRejectedValue(new Error('must not resolve'));
    try {
      for (const target of ['example.com', 'localhost', '10.1.2.3', 'metadata.google.internal']) {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/policy/check',
          payload: { action: 'request', target },
        });
        expect(response.statusCode).toBe(200);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it('agrees with enforcement on an IP literal', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/policy/check',
      payload: { action: 'request', target: '127.0.0.1' },
    });
    const body = response.json() as {
      answers: Array<{
        answer: { kind: string; decision?: { allowed: boolean; ruleMatched: string } };
      }>;
    };
    expect(body.answers[0]?.answer.kind).toBe('decision');
    expect(body.answers[0]?.answer.decision).toMatchObject({
      allowed: false,
      ruleMatched: 'env.block-loopback',
    });
  });
  it('a url is accepted and its hostname classified', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/policy/check',
      payload: { action: 'request', url: 'https://10.1.2.3/x' },
    });
    const body = response.json() as {
      target: string;
      answers: Array<{ answer: { kind: string } }>;
    };
    expect(body.target).toBe('10.1.2.3');
    expect(body.answers[0]?.answer.kind).toBe('decision');
  });
  it('a caller-supplied tenantId never overrides the authenticated one', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/policy/check',
      payload: { action: 'downloads', tenantId: 'qa' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      answers: Array<{ answer: { decision?: { ruleMatched: string } } }>;
    };
    expect(body.answers[0]?.answer.decision?.ruleMatched).toBe('env.capability.default');
  });
  it('rejects an unknown action', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/policy/check',
      payload: { action: 'nonsense' },
    });
    expect(response.statusCode).toBe(400);
  });
  it('is rate limited per tenant', async () => {
    let limited = 0;
    for (let i = 0; i < 35; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/policy/check',
        payload: { action: 'act' },
      });
      if (response.statusCode === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
