/**
 * T5 J3b: the read-only journal surfaces over HTTP.
 *
 * D1 (amended): a tenant API key OR the operator key may read, tenant-scoped; delegated agent
 * grants are refused; keyless deployments get no surface. Writes do not exist here (J3c).
 * Records are seeded through the journal facade on a service that is then closed, and the REST
 * server reopens the same namespace: the states under test are exactly what a departed process
 * leaves behind.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { journalConfigFromEnvironment, openServiceJournal } from './journal-config.js';
import { buildServer } from './server.js';
import { AgentBrowserService } from './service.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.restoreAllMocks();
});

function journalEnvironment(initialize: boolean) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'journal-http-'));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'store'), { mode: 0o700 });
  mkdirSync(join(base, 'anchor'), { mode: 0o700 });
  writeFileSync(join(base, 'key'), `key-1:${'99'.repeat(32)}\n`, { mode: 0o600 });
  const operatorKeyFile = join(base, 'operator.keys');
  writeFileSync(operatorKeyFile, 'operator-key-http-test-0001:owner\n', { mode: 0o600 });
  return {
    base,
    store: join(base, 'store'),
    env: {
      AGENTBROWSER_JOURNAL_DIR: join(base, 'store'),
      AGENTBROWSER_JOURNAL_ANCHOR_DIR: join(base, 'anchor'),
      AGENTBROWSER_JOURNAL_KEY_FILE: join(base, 'key'),
      AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'generation-1',
      AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: '2099-01-01T00:00:00Z',
      ...(initialize ? { AGENTBROWSER_JOURNAL_INITIALIZE: '1' } : {}),
      AGENTBROWSER_OPERATOR_KEYS_FILE: operatorKeyFile,
    } as Record<string, string | undefined>,
  };
}

const NAMES = ['A'.repeat(22), 'i'.repeat(22)] as const;
const intentOf = (operationId: string, tenantId: string, incarnationIndex: 0 | 1, epoch = 1) => ({
  key: {
    serviceGeneration: 's'.repeat(22),
    tenantId,
    sessionIncarnation: NAMES[incarnationIndex],
    epoch,
    operationId,
  },
  actor: 'operator',
  application: {
    adapterId: 'owned-counter',
    resourceId: 'account',
    bindingGeneration: 'binding-1',
  },
  liveFingerprint: { algorithm: 'application-operation:v1', digest: `seed-${operationId}` },
});

/** Seeds one record per classification on a store that the REST server later reopens. */
async function seedStates(store: string, env: Record<string, string | undefined>) {
  const config = await journalConfigFromEnvironment(env);
  if (!config) throw new Error('expected configuration');
  const opened = await openServiceJournal(config);
  const journal = opened.journal;
  const identityOf = (operationId: string, tenantId = 'owner') =>
    journal.namespace && intentOf(operationId, tenantId, 0);
  const acknowledged = async (intent: ReturnType<typeof intentOf>) => {
    const call = await journal.reserveIntent(intent);
    if (call.kind !== 'acknowledged') throw new Error(`seed failed: ${call.kind}`);
    return call.record.identity;
  };

  // rev 1: undispatched.
  await acknowledged(intentOf('http-undispatched', 'owner', 0));
  // rev 2, dispatched: in doubt.
  {
    const identity = await acknowledged(intentOf('http-in-doubt', 'owner', 0));
    const call = await journal.markDispatch({ identity, expectedRevision: 1 });
    if (call.kind !== 'acknowledged') throw new Error(`seed dispatch failed: ${call.kind}`);
  }
  // rev 2, failed pre-dispatch.
  {
    const identity = await acknowledged(intentOf('http-failed-before', 'owner', 1, 2));
    const call = await journal.commitTerminal({
      identity,
      expectedRevision: 1,
      dispatched: false,
      terminal: { status: 'failed', evidenceRefIds: [] },
    });
    if (call.kind !== 'acknowledged') throw new Error(`seed predispatch failed: ${call.kind}`);
  }
  // rev 3: completed and settled unknown, in two incarnations of one operation ID.
  for (const [operationId, incarnation, status] of [
    ['http-completed', 0, 'completed'],
    ['http-settled', 1, 'outcome_unknown'],
  ] as const) {
    const identity = await acknowledged(
      intentOf(operationId, 'owner', incarnation as 0 | 1, incarnation === 1 ? 3 : 1)
    );
    await journal.markDispatch({ identity, expectedRevision: 1 });
    const call = await journal.commitTerminal({
      identity,
      expectedRevision: 2,
      dispatched: true,
      terminal: { status, evidenceRefIds: [] },
    });
    if (call.kind !== 'acknowledged') throw new Error(`seed terminal failed: ${call.kind}`);
  }
  // Another tenant's record: never disclosed to the owner credential.
  await acknowledged(intentOf('http-secret', 'someone-else', 0));
  await opened.close();
  expect(store).toBeTruthy();
  void identityOf;
}

const apiKey = 'api-key-journal-http-test';
const apiHeaders = { authorization: `Bearer ${apiKey}` };
const operatorHeaders = { authorization: 'Bearer operator-key-http-test-0001' };

async function buildRestServer(
  env: Record<string, string | undefined>,
  options: { apiKeys?: boolean } = {}
) {
  const names = Object.keys(env);
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  cleanup.push(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  cleanup.push(() => warn.mockRestore());
  const server = await buildServer({
    engine: new FakeEngine(),
    ...(options.apiKeys === false
      ? {}
      : {
          apiKeys: new Map([[createHash('sha256').update(apiKey).digest('hex'), 'owner']]),
        }),
  });
  cleanup.push(() => server.close());
  return server;
}

describe('GET /v1/journal/operations/:operationId (J3b)', () => {
  it('classifies each departed state, stays tenant-scoped, and reports absence honestly', async () => {
    const seeded = journalEnvironment(true);
    await seedStates(seeded.store, seeded.env);
    const { AGENTBROWSER_JOURNAL_INITIALIZE: _drop, ...reopenEnv } = seeded.env;
    const server = await buildRestServer(reopenEnv);

    const lookup = (operationId: string, headers = apiHeaders) =>
      server.inject({ method: 'GET', url: `/v1/journal/operations/${operationId}`, headers });

    const expected: Record<string, { classification: string; actionable: boolean }> = {
      'http-undispatched': { classification: 'undispatched', actionable: true },
      'http-in-doubt': { classification: 'in_doubt', actionable: true },
      'http-failed-before': { classification: 'failed_before_dispatch', actionable: false },
      'http-completed': { classification: 'completed', actionable: false },
      'http-settled': { classification: 'settled_unknown', actionable: false },
    };
    for (const [operationId, projection] of Object.entries(expected)) {
      const response = await lookup(operationId);
      expect(response.statusCode, response.body).toBe(200);
      const result = response.json();
      expect(result).toMatchObject({
        schemaVersion: 1,
        operationId,
        absent: false,
        truncated: false,
      });
      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({
        namespace: 'agentbrowser',
        ...projection,
        application: {
          adapter: 'owned-counter',
          resource: 'account',
          bindingGeneration: 'binding-1',
        },
        session: { sessionIncarnation: expect.any(String), epoch: expect.any(Number) },
      });
    }

    // Another tenant's operation ID is scoped absence for this credential, never disclosure.
    const foreign = await lookup('http-secret');
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json()).toMatchObject({ absent: true, records: [] });
    // Absence in this namespace is not proof of non-execution.
    expect((await lookup('never-existed')).json()).toMatchObject({ absent: true });

    // The operator key reads the same surface.
    expect((await lookup('http-completed', operatorHeaders)).statusCode).toBe(200);
  }, 60_000);

  it('refuses delegated grants, keyless callers, and invalid IDs', async () => {
    const seeded = journalEnvironment(true);
    await seedStates(seeded.store, seeded.env);
    const { AGENTBROWSER_JOURNAL_INITIALIZE: _drop, ...reopenEnv } = seeded.env;
    const server = await buildRestServer(reopenEnv);
    // A delegated grant is session-bound; the journal route names no session.
    const session = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: apiHeaders,
      payload: { controlMode: 'delegated' },
    });
    const delegated = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.json().sessionId}/control/prepare-resume`,
      headers: apiHeaders,
    });
    const grant = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.json().sessionId}/control/delegate`,
      headers: apiHeaders,
      payload: { epoch: delegated.json().epoch },
    });
    const refused = await server.inject({
      method: 'GET',
      url: '/v1/journal/operations/http-completed',
      headers: { authorization: `Bearer ${grant.json().token}` },
    });
    expect(refused.statusCode).toBe(403);

    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/v1/journal/operations/http-completed',
          headers: { authorization: 'Bearer not-a-key' },
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/v1/journal/operations/bad id',
          headers: apiHeaders,
        })
      ).statusCode
    ).toBe(400);
  }, 60_000);

  it('is 404 when no journal is configured, and 401 for keyless callers when one is', async () => {
    const noJournal = await buildServer({
      engine: new FakeEngine(),
      apiKeys: new Map([[createHash('sha256').update(apiKey).digest('hex'), 'owner']]),
    });
    cleanup.push(() => noJournal.close());
    expect(
      (
        await noJournal.inject({
          method: 'GET',
          url: '/v1/journal/operations/any-op',
          headers: apiHeaders,
        })
      ).statusCode
    ).toBe(404);

    const seeded = journalEnvironment(true);
    await seedStates(seeded.store, seeded.env);
    const reopenEnv = {
      ...seeded.env,
      AGENTBROWSER_JOURNAL_INITIALIZE: undefined,
      AGENTBROWSER_OPERATOR_KEYS_FILE: undefined,
    };
    const keyless = await buildRestServer(reopenEnv);
    // Keyless deployments authenticate nobody: no credential names a tenant.
    expect(
      (await keyless.inject({ method: 'GET', url: '/v1/journal/operations/any-op' })).statusCode
    ).toBe(401);
  }, 60_000);
});

describe('GET /v1/journal (J3b, D5)', () => {
  it('reports the configured namespace, health, horizons and the qualified runtime', async () => {
    const seeded = journalEnvironment(true);
    await seedStates(seeded.store, seeded.env);
    const { AGENTBROWSER_JOURNAL_INITIALIZE: _drop, ...reopenEnv } = seeded.env;
    const server = await buildRestServer(reopenEnv);
    const response = await server.inject({
      method: 'GET',
      url: '/v1/journal',
      headers: apiHeaders,
    });
    expect(response.statusCode, response.body).toBe(200);
    const status = response.json();
    expect(status).toMatchObject({
      schemaVersion: 1,
      configured: true,
      namespace: 'agentbrowser',
      health: 'open',
      acceptUntil: '2099-01-01T00:00:00.000Z',
      retainUntil: '2099-01-31T00:00:00.000Z',
      runtime: { platform: process.platform, node: process.versions.node },
    });
    // recoveryQualified follows the same matrix the route computes; never asserted as a constant.
    const { journalRuntimeQualified } = await import('./journal-config.js');
    expect(status.recoveryQualified).toBe(journalRuntimeQualified());
    expect(status.runtime.qualified).toBe(journalRuntimeQualified());

    // Keyless with the journal configured (its own store: one server per store): nobody
    // authenticates, so no surface.
    const keylessSeed = journalEnvironment(true);
    await seedStates(keylessSeed.store, keylessSeed.env);
    const keyless = await buildRestServer(
      {
        ...keylessSeed.env,
        AGENTBROWSER_JOURNAL_INITIALIZE: undefined,
        AGENTBROWSER_OPERATOR_KEYS_FILE: undefined,
      },
      { apiKeys: false }
    );
    const bare = await keyless.inject({ method: 'GET', url: '/v1/journal' });
    expect(bare.statusCode).toBe(401);
  }, 60_000);
});
