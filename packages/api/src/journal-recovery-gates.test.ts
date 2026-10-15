/**
 * T5 J4 (D4): events and cursors are not recovered. The event ledger is per process and per
 * session; after a restart the old session no longer exists, so a pre-restart cursor fails as
 * session-not-found — never a silent reset to zero, and never a journal replay.
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
/** The store's committed rows, read directly (read-only) — independent of any service. */
const storeRows = (store: string): number => {
  const database = new DatabaseSync(join(store, 'journal.sqlite'), { readOnly: true });
  try {
    return Number(
      (database.prepare('SELECT count(*) AS n FROM journal_record').get() as { n: number }).n
    );
  } finally {
    database.close();
  }
};

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function journalEnvironment() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'j4-'));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'store'), { mode: 0o700 });
  mkdirSync(join(base, 'anchor'), { mode: 0o700 });
  writeFileSync(join(base, 'key'), `key-1:${'4a'.repeat(32)}\n`, { mode: 0o600 });
  return {
    store: join(base, 'store'),
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

describe('events and cursors across a durable restart (J4, D4)', () => {
  it('a pre-restart event cursor fails as session-not-found; the journal replays nothing', async () => {
    const { store, env } = journalEnvironment();
    // Instance A: one session with ONE durable journaled write, so "no replay" is falsifiable —
    // there IS something in the journal a wrong implementation could replay. Graceful stop; the
    // store is read directly as the independent oracle.
    const config = await journalConfigFromEnvironment(env);
    if (!config) throw new Error('expected configuration');
    const opened = await openServiceJournal(config);
    let effects = 0;
    const first = new AgentBrowserService({
      engine: new FakeEngine(),
      operationJournal: opened.journal,
      applicationAdapters: [
        {
          id: 'counter',
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
    const sessionA = await first.createSession({ tenantId: 'owner', controlMode: 'delegated' });
    first.applicationBind(sessionA.sessionId, operator, {
      adapter: 'counter',
      resource: 'account',
    });
    await first.applicationExecute(sessionA.sessionId, operator, {
      operation: 'add',
      input: 1,
      operationId: 'd4-baseline',
      expectedVersion: 0,
      executionRequirement: 'durable',
    });
    expect(effects).toBe(1);
    await first.shutdown();
    await opened.close();
    // Positive baseline: the durable row SURVIVED the restart (one row, read directly).
    expect(storeRows(store)).toBe(1);

    // Instance B reopens the same namespace.
    const { AGENTBROWSER_JOURNAL_INITIALIZE: _drop, ...reopen } = env;
    const configB = await journalConfigFromEnvironment(reopen);
    if (!configB) throw new Error('expected configuration');
    const reopened = await openServiceJournal(configB);
    const second = new AgentBrowserService({
      engine: new FakeEngine(),
      operationJournal: reopened.journal,
    });
    cleanup.push(async () => {
      await second.shutdown();
      await reopened.close();
    });

    // The old session is gone: its event cursor cannot be resumed — session-not-found, never a
    // silent reset to zero.
    expect(() =>
      second.getSessionEvents(sessionA.sessionId, { type: 'request', since: 0 })
    ).toThrow(/does not exist/);
    // No replay: the row set and the baseline row are unchanged by the attempt, and the
    // surviving record is still readable through the new process's journal handle.
    expect(storeRows(store)).toBe(1);
    const surviving = await reopened.journal.findByOperation({
      tenantId: 'owner',
      operationId: 'd4-baseline',
      limit: 16,
    });
    expect(surviving).toMatchObject({
      kind: 'found',
      truncated: false,
      records: [{ identity: { key: { operationId: 'd4-baseline' } }, revision: 3 }],
    });
  }, 120_000);
});
