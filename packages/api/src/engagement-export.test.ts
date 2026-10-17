// T10 M2: export a tenant's engagement ledger, during and after the session,
// across a restart; never another tenant's.
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyEngagementLedger } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');
const apiKeys = () =>
  new Map([
    [keyHash('key-one'), 'one'],
    [keyHash('key-two'), 'two'],
  ]);
let dir: string | undefined;
const saved = process.env.AGENTBROWSER_ENGAGEMENT_DIR;
const savedOperator = process.env.AGENTBROWSER_OPERATOR_KEYS_FILE;
afterEach(async () => {
  if (saved === undefined) delete process.env.AGENTBROWSER_ENGAGEMENT_DIR;
  else process.env.AGENTBROWSER_ENGAGEMENT_DIR = saved;
  if (savedOperator === undefined) delete process.env.AGENTBROWSER_OPERATOR_KEYS_FILE;
  else process.env.AGENTBROWSER_OPERATOR_KEYS_FILE = savedOperator;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function server() {
  return buildServer({ engine: new FakeEngine(), apiKeys: apiKeys() });
}
const as = (key: string) => ({ authorization: `Bearer ${key}` });

describe('engagement export (T10 M2)', () => {
  it('exports the caller’s ledger verbatim, open then closed, and after a restart', async () => {
    dir = await mkdtemp(join(tmpdir(), 'eng-export-'));
    await chmod(dir, 0o700);
    process.env.AGENTBROWSER_ENGAGEMENT_DIR = dir;
    let app = await server();
    let engagementId: string;
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: as('key-one'),
        payload: {
          tenantId: 'one',
          policy: { scope: { allowedHosts: ['a.example'], ledger: true } },
        },
      });
      expect(created.statusCode).toBe(201);
      ({ engagementId } = created.json());
      expect(engagementId).toMatch(/^eng_[0-9a-f]{24}$/);
      const open = await app.inject({
        method: 'GET',
        url: `/v1/engagements/${engagementId}`,
        headers: as('key-one'),
      });
      expect(open.statusCode).toBe(200);
      expect(open.headers['content-type']).toContain('application/x-ndjson');
      expect(verifyEngagementLedger(open.body)).toMatchObject({ ok: true, closed: false });
      // Another tenant, a bad id, no credential.
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/engagements/${engagementId}`,
            headers: as('key-two'),
          })
        ).statusCode
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/engagements/eng_..%2F..%2Fx',
            headers: as('key-one'),
          })
        ).statusCode
      ).toBe(404);
      expect(
        (await app.inject({ method: 'GET', url: `/v1/engagements/${engagementId}` })).statusCode
      ).toBe(401);
      await app.inject({
        method: 'DELETE',
        url: `/v1/sessions/${created.json().sessionId}`,
        headers: as('key-one'),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const closed = await app.inject({
        method: 'GET',
        url: `/v1/engagements/${engagementId}`,
        headers: as('key-one'),
      });
      expect(verifyEngagementLedger(closed.body)).toMatchObject({ ok: true, closed: true });
    } finally {
      await app.close();
    }
    app = await server();
    try {
      const again = await app.inject({
        method: 'GET',
        url: `/v1/engagements/${engagementId}`,
        headers: as('key-one'),
      });
      expect(again.statusCode).toBe(200);
      expect(verifyEngagementLedger(again.body)).toMatchObject({ ok: true, closed: true });
    } finally {
      await app.close();
    }
  });

  it('is 404 when no engagement directory is configured', async () => {
    delete process.env.AGENTBROWSER_ENGAGEMENT_DIR;
    const app = await server();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/engagements/eng_${'0'.repeat(24)}`,
        headers: as('key-one'),
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("the operator key exports its tenant's ledger; keyless deployments get 401", async () => {
    dir = await mkdtemp(join(tmpdir(), 'eng-export-'));
    await chmod(dir, 0o700);
    process.env.AGENTBROWSER_ENGAGEMENT_DIR = dir;
    const operatorFile = join(dir, 'operator.keys');
    await writeFile(operatorFile, 'operator-key-eng-export-0001:one\n', { mode: 0o600 });
    process.env.AGENTBROWSER_OPERATOR_KEYS_FILE = operatorFile;
    // Operator keys need a single-tenant deployment.
    const app = await buildServer({
      engine: new FakeEngine(),
      apiKeys: new Map([[keyHash('key-one'), 'one']]),
    });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: as('key-one'),
        payload: {
          tenantId: 'one',
          policy: { scope: { allowedHosts: ['a.example'], ledger: true } },
        },
      });
      const { engagementId } = created.json();
      const byOperator = await app.inject({
        method: 'GET',
        url: `/v1/engagements/${engagementId}`,
        headers: as('operator-key-eng-export-0001'),
      });
      expect(byOperator.statusCode, byOperator.body).toBe(200);
      expect(verifyEngagementLedger(byOperator.body)).toMatchObject({ ok: true });
    } finally {
      await app.close();
    }
    delete process.env.AGENTBROWSER_OPERATOR_KEYS_FILE;
    const keyless = await buildServer({ engine: new FakeEngine() });
    try {
      const response = await keyless.inject({
        method: 'GET',
        url: `/v1/engagements/eng_${'0'.repeat(24)}`,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    } finally {
      await keyless.close();
    }
  });
});
