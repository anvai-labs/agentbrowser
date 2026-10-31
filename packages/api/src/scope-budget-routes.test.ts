import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

it('authenticates the separate budget grant route, validates strictly and refuses unledgered grants', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'budget-route-'));
  const operatorKey = 'operator-budget-key-aaaaaaaa';
  const file = join(directory, 'operator.keys');
  await writeFile(file, `${operatorKey}:one\n`, { mode: 0o600 });
  vi.stubEnv('AGENTBROWSER_OPERATOR_KEYS_FILE', file);
  const app = await buildServer({
    engine: new FakeEngine(),
    apiKeys: new Map([[createHash('sha256').update('api-key').digest('hex'), 'one']]),
  });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: 'Bearer api-key' },
      payload: {
        tenantId: 'one',
        policy: { scope: { allowedHosts: ['app.test'], requestBudget: 1 } },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().sessionId;
    const url = `/v1/operator/sessions/${id}/scope/budget`;
    const grant = { expectedRevision: 0, requestBudget: 10 };
    const ordinary = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer api-key' },
      payload: grant,
    });
    expect(ordinary.statusCode).toBe(403);
    const unknown = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${operatorKey}` },
      payload: { ...grant, allowedMethods: ['PUT'] },
    });
    expect(unknown.statusCode).toBe(400);
    const unledgered = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${operatorKey}` },
      payload: grant,
    });
    expect(unledgered.statusCode).toBe(403);
    expect(unledgered.json().error.details.scope).toBe('SCOPE_LEDGER_UNAVAILABLE');
    const view = await app.inject({
      url: `/v1/sessions/${id}/scope`,
      headers: { authorization: 'Bearer api-key' },
    });
    expect(view.json()).toMatchObject({
      revision: 0,
      budget: { limit: 1, spent: 0, remaining: 1 },
    });
    const traffic = await app.inject({
      url: `/v1/sessions/${id}/scope/traffic`,
      headers: { authorization: 'Bearer api-key' },
    });
    expect(traffic.statusCode).toBe(200);
    expect(traffic.json()).toEqual({ rows: [], truncated: false });
  } finally {
    await app.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it('documents the actual unsupported-engine traffic response', async () => {
  const engine = new FakeEngine();
  const caps = await engine.capabilities();
  vi.spyOn(engine, 'capabilities').mockResolvedValue({ ...caps, requestRecording: false });
  const app = await buildServer({ engine });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: {
        tenantId: 'local',
        trace: 'off',
        policy: { scope: { allowedHosts: ['app.test'] } },
      },
    });
    expect(created.statusCode).toBe(201);
    const result = await app.inject({
      url: `/v1/sessions/${created.json().sessionId}/scope/traffic`,
    });
    expect(result.statusCode).toBe(422);
    expect(result.json().error.code).toBe('ENGINE_UNSUPPORTED');
    const document = (await app.inject({ url: '/openapi.json' })).json();
    expect(
      document.paths['/v1/sessions/{sessionId}/scope/traffic'].get.responses['422']
    ).toBeDefined();
  } finally {
    await app.close();
  }
});
