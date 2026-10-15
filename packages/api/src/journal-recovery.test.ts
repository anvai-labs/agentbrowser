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
import type { ApplicationAdapter } from '@agentbrowser/control';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

async function fixtureWithHorizon(acceptUntil: number) {
  const { env } = journalEnvironment();
  env.AGENTBROWSER_JOURNAL_ACCEPT_UNTIL = new Date(acceptUntil).toISOString();
  const config = await journalConfigFromEnvironment(env);
  if (!config) throw new Error('expected configuration');
  const opened = await openServiceJournal(config);
  const service = new AgentBrowserService({
    engine: new FakeEngine(),
    operationJournal: opened.journal,
  } satisfies Partial<ServiceDependencies> as ServiceDependencies);
  return {
    service,
    journal: opened.journal,
    stop: async () => {
      await service.shutdown();
      await opened.close();
    },
  };
}

async function fixture(
  applicationAdapters: ServiceDependencies['applicationAdapters'] = [],
  extra: Partial<ServiceDependencies> = {}
) {
  const { env } = journalEnvironment();
  const config = await journalConfigFromEnvironment(env);
  if (!config) throw new Error('expected configuration');
  const opened = await openServiceJournal(config);
  const journal = opened.journal;
  let service: AgentBrowserService;
  try {
    service = new AgentBrowserService({
      engine: new FakeEngine(),
      operationJournal: journal,
      ...(applicationAdapters ? { applicationAdapters } : {}),
      ...extra,
    } satisfies Partial<ServiceDependencies> as ServiceDependencies);
  } catch (error) {
    // A service that never existed cannot close the journal it was given.
    await opened.close();
    throw error;
  }
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
  state: 'undispatched' | 'in_doubt',
  incarnation = 'a'.repeat(22)
) {
  const reserved = await journal.reserveIntent(intentOf(operationId, incarnation));
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
    expect(result).toEqual({ closed: 1, truncated: false });
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
    // Closing again: the terminal record left the actionable window, so the operation reads
    // as absent for recovery — never re-closed, never a conflict to untangle.
    await expect(f.service.journalCloseOperation('close-me', humanOperator)).rejects.toMatchObject({
      code: 'NOT_FOUND',
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
    expect(settled).toEqual({ settled: 1, truncated: false });
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
    // Irreversible: settling again reads as absent (the terminal left the actionable window).
    await expect(
      f.service.journalSettleOperation('settle-me', humanOperator)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
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
      expect(closed.json()).toEqual({ closed: 1, truncated: false });

      // Terminal now: closing again reads as absent (404), never a re-close.
      const again = await server.inject({
        method: 'POST',
        url: '/v1/journal/operations/http-close/close',
        headers: headers.operator,
      });
      expect(again.statusCode).toBe(404);
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe('journal recovery writes, review round 1 (J3c part 1)', () => {
  it('mixed-state operation IDs compose: close takes the rev-1 record, settle the rev-2, no deadlock', async () => {
    const f = await fixture();
    cleanup.push(f.stop);
    // One operation ID, two incarnations: one undispatched, one in doubt.
    await seed(f.journal, 'mixed-op', 'undispatched', 'a'.repeat(22));
    await seed(f.journal, 'mixed-op', 'in_doubt', 'b'.repeat(22));

    const closed = await f.service.journalCloseOperation('mixed-op', humanOperator);
    expect(closed).toEqual({ closed: 1, truncated: false });
    const settled = await f.service.journalSettleOperation('mixed-op', humanOperator);
    expect(settled).toEqual({ settled: 1, truncated: false });

    const after = await f.journal.findByOperation({
      tenantId: 'owner',
      operationId: 'mixed-op',
      limit: 16,
    });
    if (after.kind !== 'found') throw new Error('expected records');
    const states = after.records
      .map(
        (record) => `${record.revision}:${record.dispatched}:${record.terminal?.status ?? 'none'}`
      )
      .sort();
    expect(states).toEqual(['2:false:failed', '3:true:outcome_unknown']);
    // Both exhausted: the actionable window is empty, so writes read as absent.
    await expect(f.service.journalCloseOperation('mixed-op', humanOperator)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  }, 60_000);

  it('closes a 128-character operation ID (the marker hashes when the literal would not fit)', async () => {
    const f = await fixture();
    cleanup.push(f.stop);
    const longId = `op-${'x'.repeat(125)}`;
    expect(longId).toHaveLength(128);
    await seed(f.journal, longId, 'undispatched');
    const result = await f.service.journalCloseOperation(longId, humanOperator);
    expect(result).toEqual({ closed: 1, truncated: false });
    const after = await f.journal.findByOperation({
      tenantId: 'owner',
      operationId: longId,
      limit: 16,
    });
    if (after.kind !== 'found') throw new Error('expected records');
    const marker = after.records[0]?.terminal?.evidenceRefIds[0] ?? '';
    // Either the literal (fits) or the deterministic hash form; always within the id bound.
    expect(marker).toMatch(/^superseded\./);
    expect(marker.length).toBeLessThanOrEqual(128);
    // Deterministic: the same ID yields the same marker.
    expect(marker).toBe(f.service.supersessionMarker(longId));
  }, 60_000);

  it('settle works after the accept horizon has passed (the deadline is retainUntil)', async () => {
    const f = await fixtureWithHorizon(Date.now() + 1_500);
    cleanup.push(f.stop);
    await seed(f.journal, 'late-settle', 'in_doubt');
    await new Promise((done) => setTimeout(done, 1_700));
    const settled = await f.service.journalSettleOperation('late-settle', humanOperator);
    expect(settled).toEqual({ settled: 1, truncated: false });
  }, 60_000);

  it('the recovery window ADVANCES: 17 undispatched records close in two acts, none stranded', async () => {
    const f = await fixture();
    cleanup.push(f.stop);
    for (let index = 0; index < 17; index += 1) {
      const reserved = await f.journal.reserveIntent(
        intentOf('many-op', `${index}`.padStart(22, 'a'))
      );
      if (reserved.kind !== 'acknowledged') throw new Error('seed failed');
    }
    const first = await f.service.journalCloseOperation('many-op', humanOperator);
    expect(first).toEqual({ closed: 16, truncated: true });
    // Terminal records leave the actionable window (the recovery query filters them out), so
    // the second act reaches the 17th instead of re-reading the same first sixteen.
    const second = await f.service.journalCloseOperation('many-op', humanOperator);
    expect(second).toEqual({ closed: 1, truncated: false });
    await expect(f.service.journalCloseOperation('many-op', humanOperator)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  }, 120_000);
});

describe('journal reconcile (T5 J3c part 2, D3, real store)', () => {
  type Identity = Parameters<NonNullable<ApplicationAdapter['reconcile']>>[0];
  /** An adapter whose reconcile answer is scripted; every call's identity is captured. */
  const scripted = (
    answer: 'committed' | 'rejected' | 'unknown' | 'throw',
    calls: Identity[] = []
  ): ApplicationAdapter => ({
    id: 'any-adapter',
    authorize: () => true,
    operations: {},
    receipt: async () => ({}),
    reconcile: async (identity) => {
      calls.push(identity);
      if (answer === 'throw') throw new Error('adapter down');
      return { status: answer };
    },
  });
  const state = async (
    journal: Awaited<ReturnType<typeof openServiceJournal>>['journal'],
    operationId: string
  ) => {
    const found = await journal.findByOperation({ tenantId: 'owner', operationId, limit: 16 });
    if (found.kind !== 'found') throw new Error('expected records');
    return found.records.map(
      (record) => `${record.revision}:${record.dispatched}:${record.terminal?.status ?? 'none'}`
    );
  };

  it('committed resolves an in-doubt record as completed, bound to the original identity', async () => {
    const calls: Identity[] = [];
    const f = await fixture([scripted('committed', calls)]);
    cleanup.push(f.stop);
    await seed(f.journal, 'rec-commit', 'in_doubt');
    await expect(f.service.journalReconcileOperation('rec-commit', humanOperator)).resolves.toEqual(
      { reconciled: 1, unresolved: 0, truncated: false }
    );
    expect(await state(f.journal, 'rec-commit')).toEqual(['3:true:completed']);
    // The adapter saw exactly the record's identity — and no fingerprint or digest.
    expect(calls).toEqual([
      {
        tenant: 'owner',
        adapter: 'any-adapter',
        resource: 'any-resource',
        bindingGeneration: 'binding-1',
        sessionIncarnation: 'a'.repeat(22),
        operationId: 'rec-commit',
      },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/digest|fingerprint/i);
  }, 60_000);

  it('rejected resolves as failed', async () => {
    const f = await fixture([scripted('rejected')]);
    cleanup.push(f.stop);
    await seed(f.journal, 'rec-reject', 'in_doubt');
    await expect(f.service.journalReconcileOperation('rec-reject', humanOperator)).resolves.toEqual(
      { reconciled: 1, unresolved: 0, truncated: false }
    );
    expect(await state(f.journal, 'rec-reject')).toEqual(['3:true:failed']);
  }, 60_000);

  it.each(['unknown', 'throw'] as const)(
    'an adapter answer of %s changes nothing: the record stays in doubt and can still be settled',
    async (answer) => {
      const f = await fixture([scripted(answer)]);
      cleanup.push(f.stop);
      await seed(f.journal, `rec-${answer}`, 'in_doubt');
      await expect(
        f.service.journalReconcileOperation(`rec-${answer}`, humanOperator)
      ).resolves.toEqual({ reconciled: 0, unresolved: 1, truncated: false });
      expect(await state(f.journal, `rec-${answer}`)).toEqual(['2:true:none']);
      await expect(
        f.service.journalSettleOperation(`rec-${answer}`, humanOperator)
      ).resolves.toEqual({ settled: 1, truncated: false });
    },
    60_000
  );

  it('an adapter without reconcile refuses typed and writes nothing (settle instead)', async () => {
    const f = await fixture([
      { id: 'any-adapter', authorize: () => true, operations: {}, receipt: async () => ({}) },
    ]);
    cleanup.push(f.stop);
    await seed(f.journal, 'rec-none', 'in_doubt');
    await expect(
      f.service.journalReconcileOperation('rec-none', humanOperator)
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(await state(f.journal, 'rec-none')).toEqual(['2:true:none']);
  }, 60_000);

  it('is operator-only: a tenant API key principal is refused before the adapter is asked', async () => {
    const calls: Identity[] = [];
    const f = await fixture([scripted('committed', calls)]);
    cleanup.push(f.stop);
    await seed(f.journal, 'rec-auth', 'in_doubt');
    await expect(
      f.service.journalReconcileOperation('rec-auth', tenantApiKeyPrincipal)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toEqual([]);
    expect(await state(f.journal, 'rec-auth')).toEqual(['2:true:none']);
  }, 60_000);

  it('touches only in-doubt records: an undispatched sibling is left for close', async () => {
    const f = await fixture([scripted('committed')]);
    cleanup.push(f.stop);
    await seed(f.journal, 'rec-mixed', 'undispatched', 'a'.repeat(22));
    await seed(f.journal, 'rec-mixed', 'in_doubt', 'b'.repeat(22));
    await expect(f.service.journalReconcileOperation('rec-mixed', humanOperator)).resolves.toEqual({
      reconciled: 1,
      unresolved: 0,
      truncated: false,
    });
    expect((await state(f.journal, 'rec-mixed')).sort()).toEqual([
      '1:false:none',
      '3:true:completed',
    ]);
    // With only the undispatched record actionable, reconcile has nothing to do.
    await expect(
      f.service.journalReconcileOperation('rec-mixed', humanOperator)
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  }, 60_000);
});

describe('journal reconcile over HTTP (J3c part 2)', () => {
  it('operator reconciles; a tenant API key is forbidden; an adapter without reconcile is 409', async () => {
    const { seedAndBuild } = await import('./test-support/journal-recovery-http.js');
    const adapter: ApplicationAdapter = {
      id: 'a',
      authorize: () => true,
      operations: {},
      receipt: async () => ({}),
      reconcile: async () => ({ status: 'committed' }),
    };
    const {
      server,
      headers,
      cleanup: done,
    } = await seedAndBuild('in_doubt', 'http-rec', [adapter]);
    try {
      const url = '/v1/journal/operations/http-rec/reconcile';
      const forbidden = await server.inject({ method: 'POST', url, headers: headers.apiKey });
      expect(forbidden.statusCode).toBe(403);
      const ok = await server.inject({ method: 'POST', url, headers: headers.operator });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toEqual({ reconciled: 1, unresolved: 0, truncated: false });
      // Resolved: the record left the actionable window.
      const again = await server.inject({ method: 'POST', url, headers: headers.operator });
      expect(again.statusCode).toBe(404);
    } finally {
      await done();
    }

    const bare = await seedAndBuild('in_doubt', 'http-rec-none', [
      { id: 'a', authorize: () => true, operations: {}, receipt: async () => ({}) },
    ]);
    try {
      const refused = await bare.server.inject({
        method: 'POST',
        url: '/v1/journal/operations/http-rec-none/reconcile',
        headers: bare.headers.operator,
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('CONTROL_REQUIRED');
    } finally {
      await bare.cleanup();
    }
  }, 120_000);
});

describe('journal reconcile hardening (J3c part 2, review round 1)', () => {
  const intentFor = (operationId: string, adapterId: string, incarnation: string) => {
    const intent = intentOf(operationId, incarnation);
    return { ...intent, application: { ...intent.application, adapterId } };
  };
  const seedInDoubt = async (
    journal: Awaited<ReturnType<typeof openServiceJournal>>['journal'],
    operationId: string,
    adapterId: string,
    incarnation: string
  ) => {
    const reserved = await journal.reserveIntent(intentFor(operationId, adapterId, incarnation));
    if (reserved.kind !== 'acknowledged') throw new Error('seed failed');
    await journal.markDispatch({ identity: reserved.record.identity, expectedRevision: 1 });
  };
  const records = async (
    journal: Awaited<ReturnType<typeof openServiceJournal>>['journal'],
    operationId: string
  ) => {
    const found = await journal.findByOperation({ tenantId: 'owner', operationId, limit: 16 });
    if (found.kind !== 'found') throw new Error('expected records');
    return found.records.map((record) => record.terminal?.status ?? 'none').sort();
  };
  const plain = (id: string, reconcile?: ApplicationAdapter['reconcile']): ApplicationAdapter => ({
    id,
    authorize: () => true,
    operations: {},
    receipt: async () => ({}),
    ...(reconcile ? { reconcile } : {}),
  });

  it('resolves every adapter before any write: one adapter lacking reconcile means nothing is written', async () => {
    const asked = vi.fn(async () => ({ status: 'committed' as const }));
    const f = await fixture([plain('capable', asked), plain('incapable')]);
    cleanup.push(f.stop);
    await seedInDoubt(f.journal, 'two-adapters', 'capable', 'a'.repeat(22));
    await seedInDoubt(f.journal, 'two-adapters', 'incapable', 'b'.repeat(22));
    await expect(
      f.service.journalReconcileOperation('two-adapters', humanOperator)
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(asked).not.toHaveBeenCalled();
    expect(await records(f.journal, 'two-adapters')).toEqual(['none', 'none']);
  }, 60_000);

  it('bounds a reconcile that never settles: it counts as unresolved and the record stays in doubt', async () => {
    const f = await fixture([plain('any-adapter', () => new Promise(() => {}))], {
      journalReconcileTimeoutMs: 200,
    });
    cleanup.push(f.stop);
    await seed(f.journal, 'hangs', 'in_doubt');
    await expect(f.service.journalReconcileOperation('hangs', humanOperator)).resolves.toEqual({
      reconciled: 0,
      unresolved: 1,
      truncated: false,
    });
    expect(await records(f.journal, 'hangs')).toEqual(['none']);
  }, 60_000);

  it.each([
    ['an extra key', () => ({ status: 'committed', evidence: ['x'] })],
    ['an inherited status', () => Object.create({ status: 'committed' })],
    [
      'a getter status',
      () => Object.defineProperty({}, 'status', { enumerable: true, get: () => 'committed' }),
    ],
    ['a wrong case', () => ({ status: 'COMMITTED' })],
    ['null', () => null],
  ] as const)(
    'reads the adapter answer strictly: %s resolves nothing',
    async (_name, answer) => {
      const f = await fixture([plain('any-adapter', async () => answer() as never)]);
      cleanup.push(f.stop);
      await seed(f.journal, `strict-${_name.replace(/\W+/g, '-')}`, 'in_doubt');
      await expect(
        f.service.journalReconcileOperation(`strict-${_name.replace(/\W+/g, '-')}`, humanOperator)
      ).resolves.toEqual({ reconciled: 0, unresolved: 1, truncated: false });
    },
    60_000
  );

  it('refuses an adapter whose reconcile is not a function at construction', async () => {
    await expect(
      fixture([{ ...plain('any-adapter'), reconcile: 'yes' } as unknown as ApplicationAdapter])
    ).rejects.toThrow(/non-function reconcile/);
  });

  it('captures reconcile once: replacing it on the adapter object later changes nothing', async () => {
    const original = vi.fn(async () => ({ status: 'committed' as const }));
    const adapter = plain('any-adapter', original);
    const f = await fixture([adapter]);
    cleanup.push(f.stop);
    (adapter as { reconcile?: unknown }).reconcile = async () => ({ status: 'rejected' });
    await seed(f.journal, 'captured', 'in_doubt');
    await f.service.journalReconcileOperation('captured', humanOperator);
    expect(original).toHaveBeenCalledTimes(1);
    expect(await records(f.journal, 'captured')).toEqual(['completed']);
  }, 60_000);
});
