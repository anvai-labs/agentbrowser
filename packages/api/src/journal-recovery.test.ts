/**
 * T5 J3c (part 1): the operator-only recovery writes — close (D2's first half) and settle (D3's
 * operator fallback) — against a real store, through the service.
 *
 * D1 as amended: reads are for the operator or a tenant API key; WRITES are for the ADR-025
 * operator principal (`actor: 'human-operator'`) only. A tenant API key authenticates as
 * `actor: 'operator'` and must be refused — that hazard is called out in the accepted design and
 * pinned here. Settlement is irreversible; close is only legal on a never-dispatched record.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { journalConfigFromEnvironment, openServiceJournal } from './journal-config.js';
import { AgentBrowserService, type ServiceDependencies } from './service.js';

const humanOperator = { actor: 'human-operator' as const, tenant: 'owner' };
const tenantApiKeyPrincipal = { actor: 'operator' as const, tenant: 'owner' };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function journalEnvironment() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'j3c-'));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'store'), { mode: 0o700 });
  mkdirSync(join(base, 'anchor'), { mode: 0o700 });
  writeFileSync(join(base, 'key'), `key-1:${'3c'.repeat(32)}\n`, { mode: 0o600 });
  return {
    env: {
      AGENTBROWSER_JOURNAL_DIR: join(base, 'store'),
      AGENTBROWSER_JOURNAL_ANCHOR_DIR: join(base, 'anchor'),
      AGENTBROWSER_JOURNAL_KEY_FILE: join(base, 'key'),
      AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'generation-1',
      AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: '2099-01-01T00:00:00Z',
      AGENTBROWSER_JOURNAL_INITIALIZE: '1',
    } as Record<string, string | undefined>,
  };
}

async function fixture() {
  const { env } = journalEnvironment();
  const config = await journalConfigFromEnvironment(env);
  if (!config) throw new Error('expected configuration');
  const opened = await openServiceJournal(config);
  const journal = opened.journal;
  const service = new AgentBrowserService({
    engine: new FakeEngine(),
    operationJournal: journal,
  } satisfies Partial<ServiceDependencies> as ServiceDependencies);
  return {
    service,
    journal,
    stop: async () => {
      await service.shutdown();
      await opened.close();
    },
  };
}

const intentOf = (operationId: string, incarnation = 'a'.repeat(22)) => ({
  key: {
    serviceGeneration: 's'.repeat(22),
    tenantId: 'owner',
    sessionIncarnation: incarnation,
    epoch: 1,
    operationId,
  },
  actor: 'operator',
  application: {
    adapterId: 'any-adapter',
    resourceId: 'any-resource',
    bindingGeneration: 'binding-1',
  },
  liveFingerprint: { algorithm: 'application-operation:v1', digest: `digest-${operationId}` },
});

/** Seeds one record at each actionable state through the facade. */
async function seed(
  journal: Awaited<ReturnType<typeof openServiceJournal>>['journal'],
  operationId: string,
  state: 'undispatched' | 'in_doubt'
) {
  const reserved = await journal.reserveIntent(intentOf(operationId));
  if (reserved.kind !== 'acknowledged') throw new Error(`seed failed: ${reserved.kind}`);
  if (state === 'in_doubt') {
    const dispatched = await journal.markDispatch({
      identity: reserved.record.identity,
      expectedRevision: 1,
    });
    if (dispatched.kind !== 'acknowledged') throw new Error('seed dispatch failed');
  }
  return reserved.record.identity;
}

describe('journal recovery writes (T5 J3c part 1, real store)', () => {
  it('closes an undispatched record as a marked pre-dispatch failure, operator only', async () => {
    const f = await fixture();
    cleanup.push(f.stop);
    await seed(f.journal, 'close-me', 'undispatched');

    // A tenant API key principal is refused: writes are human-operator only (D1 hazard).
    await expect(
      f.service.journalCloseOperation('close-me', tenantApiKeyPrincipal)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const result = await f.service.journalCloseOperation('close-me', humanOperator);
    expect(result).toMatchObject({ closed: 1 });
    const after = await f.journal.findByOperation({
      tenantId: 'owner',
      operationId: 'close-me',
      limit: 16,
    });
    expect(after).toMatchObject({
      kind: 'found',
      records: [{ revision: 2, dispatched: false, terminal: { status: 'failed' } }],
    });
    // The terminal carries the supersession marker (evidence-ref id format).
    if (after.kind === 'found') {
      expect(after.records[0]?.terminal?.evidenceRefIds[0]).toMatch(/^superseded\.close-me$/);
    }
    // Closing again is refused: the record is terminal now, not actionable.
    await expect(f.service.journalCloseOperation('close-me', humanOperator)).rejects.toMatchObject({
      code: 'OPERATION_CONFLICT',
    });
  }, 60_000);

  it('refuses to close an in-doubt record (dispatched work is settled or reconciled, never closed)', async () => {
    const f = await fixture();
    cleanup.push(f.stop);
    await seed(f.journal, 'in-doubt-op', 'in_doubt');
    await expect(
      f.service.journalCloseOperation('in-doubt-op', humanOperator)
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  }, 60_000);

  it('settles an in-doubt record as terminal unknown, irreversibly, operator only', async () => {
    const f = await fixture();
    cleanup.push(f.stop);
    await seed(f.journal, 'settle-me', 'in_doubt');

    await expect(
      f.service.journalSettleOperation('settle-me', tenantApiKeyPrincipal)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const settled = await f.service.journalSettleOperation('settle-me', humanOperator);
    expect(settled).toMatchObject({ settled: 1 });
    const after = await f.journal.findByOperation({
      tenantId: 'owner',
      operationId: 'settle-me',
      limit: 16,
    });
    expect(after).toMatchObject({
      kind: 'found',
      records: [
        {
          revision: 3,
          dispatched: true,
          terminal: { status: 'outcome_unknown', evidenceRefIds: [] },
        },
      ],
    });
    // Irreversible: settling again (or closing) refuses on the terminal record.
    await expect(
      f.service.journalSettleOperation('settle-me', humanOperator)
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  }, 60_000);

  it('refuses to settle an undispatched record or a missing one', async () => {
    const f = await fixture();
    cleanup.push(f.stop);
    await seed(f.journal, 'never-ran', 'undispatched');
    await expect(
      f.service.journalSettleOperation('never-ran', humanOperator)
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    await expect(
      f.service.journalSettleOperation('absent-op', humanOperator)
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  }, 60_000);

  it('scopes to the operator tenant and stays tenant-honest', async () => {
    const f = await fixture();
    cleanup.push(f.stop);
    const other = intentOf('foreign-op');
    other.key.tenantId = 'someone-else';
    const reserved = await f.journal.reserveIntent(other);
    if (reserved.kind !== 'acknowledged') throw new Error('seed failed');
    // The operator's tenant is 'owner': the other tenant's record is absent for them.
    await expect(
      f.service.journalSettleOperation('foreign-op', humanOperator)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 60_000);
});

describe('journal recovery writes over HTTP (J3c part 1)', () => {
  it('operator key closes; a tenant API key is forbidden; state conflicts are 409', async () => {
    const { seedAndBuild } = await import('./test-support/journal-recovery-http.js');
    const { server, headers, cleanup } = await seedAndBuild('undispatched', 'http-close');
    try {
      // A tenant API key may read but never write recovery state.
      const forbidden = await server.inject({
        method: 'POST',
        url: '/v1/journal/operations/http-close/close',
        headers: headers.apiKey,
      });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json().error.code).toBe('FORBIDDEN');

      const closed = await server.inject({
        method: 'POST',
        url: '/v1/journal/operations/http-close/close',
        headers: headers.operator,
      });
      expect(closed.statusCode, closed.body).toBe(200);
      expect(closed.json()).toEqual({ closed: 1 });

      // Terminal now: closing again conflicts.
      const again = await server.inject({
        method: 'POST',
        url: '/v1/journal/operations/http-close/close',
        headers: headers.operator,
      });
      expect(again.statusCode).toBe(409);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
