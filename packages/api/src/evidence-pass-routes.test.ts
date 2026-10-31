import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

it('keeps the evidence route operator-only and strictly validates its body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'evidence-operator-'));
  const key = 'operator-evidence-key-aaaaaaaa';
  const path = join(dir, 'keys');
  await writeFile(path, `${key}:one\n`, { mode: 0o600 });
  vi.stubEnv('AGENTBROWSER_OPERATOR_KEYS_FILE', path);
  const app = await buildServer({
    engine: new FakeEngine(),
    apiKeys: new Map([[createHash('sha256').update('api-key').digest('hex'), 'one']]),
  });
  try {
    const request = {
      scope: { allowedHosts: ['app.test'], ledger: true },
      origins: ['https://app.test'],
    };
    const agent = await app.inject({
      method: 'POST',
      url: '/v1/operator/sessions/no-source/evidence',
      headers: { authorization: 'Bearer api-key' },
      payload: request,
    });
    expect(agent.statusCode).toBe(403);
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/operator/sessions/no-source/evidence',
      headers: { authorization: `Bearer ${key}` },
      payload: { ...request, approved: true },
    });
    expect(invalid.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/operator/sessions/no-source/evidence',
      headers: { authorization: `Bearer ${key}` },
      payload: request,
    });
    expect(unknown.statusCode).toBe(404);
  } finally {
    await app.close();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
