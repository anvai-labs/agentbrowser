/**
 * T4 A2: what the service honestly claims across a durable restart, against a real store.
 *
 * A graceful restart with the journal configured (J-d) does three things, and only these:
 * 1. Records written before the restart SURVIVE and remain readable (the namespace is stable).
 * 2. Nothing is replayed: the new process executes nothing on its own.
 * 3. An operation ID re-submitted after the restart is a NEW operation — operation identity
 *    includes the process's service generation, so there is no cross-process deduplication.
 *    That is the advertised weaker outcome: the application adapter itself owns idempotency;
 *    the journal never claims it.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { journalConfigFromEnvironment, openServiceJournal } from './journal-config.js';
import { AgentBrowserService } from './service.js';

const operator = { actor: 'operator' as const, tenant: 'owner' };
const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function journalEnvironment() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'restart-a2-'));
  cleanup.push(base);
  mkdirSync(join(base, 'store'), { mode: 0o700 });
  mkdirSync(join(base, 'anchor'), { mode: 0o700 });
  writeFileSync(join(base, 'key'), `key-1:${'5a'.repeat(32)}\n`, { mode: 0o600 });
  return {
    store: join(base, 'store'),
    env: {
      AGENTBROWSER_JOURNAL_DIR: join(base, 'store'),
      AGENTBROWSER_JOURNAL_ANCHOR_DIR: join(base, 'anchor'),
      AGENTBROWSER_JOURNAL_KEY_FILE: join(base, 'key'),
      AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'generation-1',
      AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: '2099-01-01T00:00:00Z',
    } as Record<string, string | undefined>,
  };
}

/** One service process on the (reopened) store; the effect is an independent counter file. */
async function serviceProcess(
  env: Record<string, string | undefined>,
  counterFile: string,
  initialize: boolean
) {
  const config = await journalConfigFromEnvironment({
    ...env,
    ...(initialize ? { AGENTBROWSER_JOURNAL_INITIALIZE: '1' } : {}),
  });
  if (!config) throw new Error('expected configuration');
  const opened = await openServiceJournal(config);
  let effects = 0;
  const service = new AgentBrowserService({
    engine: new FakeEngine(),
    operationJournal: opened.journal,
    applicationAdapters: [
      {
        id: 'owned-counter',
        authorize: () => true,
        operations: {
          add: {
            mode: 'write' as const,
            prepare: () => async () => {
              effects += 1;
              return { status: 'committed' as const, value: effects };
            },
          },
        },
        receipt: async () => ({}),
      },
    ],
  });
  const { sessionId } = await service.createSession({
    tenantId: 'owner',
    controlMode: 'delegated',
  });
  service.applicationBind(sessionId, operator, { adapter: 'owned-counter', resource: 'account' });
  const write = (operationId: string, expectedVersion: number) =>
    service.applicationExecute(sessionId, operator, {
      operation: 'add',
      input: 1,
      operationId,
      expectedVersion,
      executionRequirement: 'durable',
    });
  return {
    write,
    effects: () => effects,
    counterFile,
    stop: async () => {
      await service.shutdown();
      await opened.close();
    },
    journal: opened.journal,
  };
}

/** The store's committed rows, read independently of any service process. */
function rows(store: string): Array<{ tenant: string; operationId: string; revision: number }> {
  const database = new DatabaseSync(join(store, 'journal.sqlite'), { readOnly: true });
  try {
    return (
      database.prepare('SELECT record FROM journal_record').all() as Array<{ record: string }>
    ).map((row) => {
      const record = JSON.parse(row.record) as {
        identity: { key: { tenantId: string; operationId: string } };
        revision: number;
      };
      return {
        tenant: record.identity.key.tenantId,
        operationId: record.identity.key.operationId,
        revision: record.revision,
      };
    });
  } finally {
    database.close();
  }
}

describe('durable restart claims (T4 A2, real store)', () => {
  it('records survive, nothing replays, and a re-submitted ID is a new operation — not deduplication', async () => {
    const { store, env } = journalEnvironment();

    // Process A: one durable write completes, then a graceful stop.
    const first = await serviceProcess(env, 'counter-a', true);
    await expect(first.write('restart-op', 0)).resolves.toMatchObject({ status: 'committed' });
    expect(first.effects()).toBe(1);
    await first.stop();
    expect(rows(store)).toEqual([{ tenant: 'owner', operationId: 'restart-op', revision: 3 }]);

    // Process B reopens the same namespace and starts empty: nothing replayed.
    const second = await serviceProcess(env, 'counter-b', false);
    try {
      expect(second.effects()).toBe(0);
      expect(rows(store)).toHaveLength(1);

      // The surviving record is readable through the new process's journal (J3a).
      const found = await second.journal.findByOperation({
        tenantId: 'owner',
        operationId: 'restart-op',
        limit: 16,
      });
      expect(found).toMatchObject({
        kind: 'found',
        truncated: false,
        records: [{ identity: { key: { operationId: 'restart-op' } }, revision: 3 }],
      });

      // The SAME operation ID re-submitted under process B is a NEW operation: it commits
      // again (two records for the ID across processes, two effects). The journal never
      // claims cross-process idempotency; the adapter owns it.
      await expect(second.write('restart-op', 0)).resolves.toMatchObject({ status: 'committed' });
      expect(second.effects()).toBe(1);
      const after = rows(store);
      expect(after).toHaveLength(2);
      expect(after.every((row) => row.operationId === 'restart-op' && row.revision === 3)).toBe(
        true
      );
      // The two records come from distinct service generations (that is what makes them
      // distinct operations), never from a replay of one another.
      const database = new DatabaseSync(join(store, 'journal.sqlite'), { readOnly: true });
      try {
        const generations = (
          database.prepare('SELECT identity FROM journal_record').all() as Array<{
            identity: string;
          }>
        ).map(
          (row) =>
            (JSON.parse(row.identity) as { key: { serviceGeneration: string } }).key
              .serviceGeneration
        );
        expect(new Set(generations).size).toBe(2);
      } finally {
        database.close();
      }
    } finally {
      await second.stop();
    }
  }, 120_000);
});
