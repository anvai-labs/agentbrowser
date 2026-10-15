/**
 * T5 J-d: the service with a real durable journal (the qualified SQLite store). Durable writes
 * are journaled and advertised only while the journal is open; ephemeral writes stay unjournaled;
 * the store's own rows are the oracle, read independently of the service.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  journalConfigFromEnvironment,
  openServiceJournal,
  type ServiceJournal,
} from './journal-config.js';
import { buildServer } from './server.js';
import { AgentBrowserService } from './service.js';

const operator = { actor: 'operator', tenant: 'owner' } as const;
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function journalEnvironment() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'svc-durable-'));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const directory = join(base, 'store');
  const anchorDirectory = join(base, 'anchor');
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(anchorDirectory, { mode: 0o700 });
  const keyFile = join(base, 'journal.key');
  writeFileSync(keyFile, `key-1:${'cd'.repeat(32)}\n`, { mode: 0o600 });
  return {
    directory,
    env: {
      AGENTBROWSER_JOURNAL_DIR: directory,
      AGENTBROWSER_JOURNAL_ANCHOR_DIR: anchorDirectory,
      AGENTBROWSER_JOURNAL_KEY_FILE: keyFile,
      AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'generation-1',
      AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: '2099-01-01T00:00:00Z',
      AGENTBROWSER_JOURNAL_INITIALIZE: '1',
    },
  };
}

/** Independent oracle: the store's committed records, read-only. */
function storedRecords(directory: string): number {
  const database = new DatabaseSync(join(directory, 'journal.sqlite'), { readOnly: true });
  try {
    const row = database.prepare('SELECT count(*) AS n FROM journal_record').get() as { n: number };
    return Number(row.n);
  } finally {
    database.close();
  }
}

async function serviceWithJournal(prepared = journalEnvironment()) {
  const { directory, env } = prepared;
  const config = await journalConfigFromEnvironment(env);
  if (!config) throw new Error('expected configuration');
  const opened: ServiceJournal = await openServiceJournal(config);
  cleanup.push(() => opened.close());
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
  cleanup.push(() => service.shutdown());
  const { sessionId } = await service.createSession({
    tenantId: 'owner',
    controlMode: 'delegated',
  });
  service.applicationBind(sessionId, operator, { adapter: 'owned-counter', resource: 'account' });
  return { service, sessionId, opened, directory, env, effects: () => effects };
}

const write = (operationId: string, expectedVersion: number, requirement?: string) => ({
  operation: 'add',
  input: 1,
  operationId,
  expectedVersion,
  ...(requirement !== undefined ? { executionRequirement: requirement } : {}),
});

describe('service with an open durable journal', () => {
  it('advertises durable, journals a durable write once, and replays it without a second effect', async () => {
    const s = await serviceWithJournal();
    expect(await s.service.applicationDiscover(s.sessionId, operator)).toMatchObject({
      writeExecution: {
        defaultRequirement: 'ephemeral',
        supportedRequirements: ['ephemeral', 'durable'],
      },
    });
    await expect(
      s.service.applicationExecute(s.sessionId, operator, write('d1', 0, 'durable'))
    ).resolves.toMatchObject({ status: 'committed' });
    expect(s.effects()).toBe(1);
    expect(storedRecords(s.directory)).toBe(1);
    await expect(
      s.service.applicationExecute(s.sessionId, operator, write('d1', 0, 'durable'))
    ).resolves.toMatchObject({ replay: true });
    expect(s.effects()).toBe(1);
    expect(storedRecords(s.directory)).toBe(1);
  }, 60_000);

  it('keeps journaled records across a restart: the next start reopens the same namespace', async () => {
    const prepared = journalEnvironment();
    const s = await serviceWithJournal(prepared);
    await s.service.applicationExecute(s.sessionId, operator, write('kept', 0, 'durable'));
    await s.service.shutdown();
    await s.opened.close();
    expect(storedRecords(s.directory)).toBe(1);
    const { AGENTBROWSER_JOURNAL_INITIALIZE: _first, ...later } = prepared.env;
    const restarted = await serviceWithJournal({
      directory: prepared.directory,
      env: later as never,
    });
    expect(restarted.opened.journal.namespace.namespaceId).toBe(
      s.opened.journal.namespace.namespaceId
    );
    expect(storedRecords(restarted.directory)).toBe(1);
    await restarted.service.applicationExecute(
      restarted.sessionId,
      operator,
      write('after-restart', 0, 'durable')
    );
    expect(storedRecords(restarted.directory)).toBe(2);
  }, 60_000);

  it('keeps ephemeral writes out of the journal', async () => {
    const s = await serviceWithJournal();
    await s.service.applicationExecute(s.sessionId, operator, write('e1', 0));
    await s.service.applicationExecute(s.sessionId, operator, write('e2', 1, 'ephemeral'));
    expect(s.effects()).toBe(2);
    expect(storedRecords(s.directory)).toBe(0);
  }, 60_000);

  it('a durable and an ephemeral write never share an identity', async () => {
    const s = await serviceWithJournal();
    await s.service.applicationExecute(s.sessionId, operator, write('same', 0, 'durable'));
    await expect(
      s.service.applicationExecute(s.sessionId, operator, write('same', 0))
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(s.effects()).toBe(1);
  }, 60_000);

  it('stops advertising and refuses durable, with no effect, once the journal closes', async () => {
    const s = await serviceWithJournal();
    await s.opened.close();
    expect(await s.service.applicationDiscover(s.sessionId, operator)).toMatchObject({
      writeExecution: { supportedRequirements: ['ephemeral'] },
    });
    await expect(
      s.service.applicationExecute(s.sessionId, operator, write('late', 0, 'durable'))
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(s.effects()).toBe(0);
  }, 60_000);
});

describe('buildServer journal configuration', () => {
  const names = [
    'AGENTBROWSER_JOURNAL_DIR',
    'AGENTBROWSER_JOURNAL_ANCHOR_DIR',
    'AGENTBROWSER_JOURNAL_KEY_FILE',
    'AGENTBROWSER_JOURNAL_RESTORE_GENERATION',
    'AGENTBROWSER_JOURNAL_ACCEPT_UNTIL',
    'AGENTBROWSER_JOURNAL_NAMESPACE',
    'AGENTBROWSER_JOURNAL_MAX_RECORDS',
    'AGENTBROWSER_JOURNAL_INITIALIZE',
  ] as const;
  const setEnvironment = (values: Partial<Record<(typeof names)[number], string>>) => {
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) {
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
    cleanup.push(() => {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });
  };

  it('refuses to start with a partial journal configuration', async () => {
    const { env } = journalEnvironment();
    setEnvironment({ ...env, AGENTBROWSER_JOURNAL_KEY_FILE: undefined });
    await expect(buildServer({ engine: new FakeEngine() })).rejects.toThrow(
      /AGENTBROWSER_JOURNAL_KEY_FILE/
    );
  });

  it('starts with a complete configuration and closes the journal with the server', async () => {
    const { env } = journalEnvironment();
    setEnvironment(env);
    const server = await buildServer({ engine: new FakeEngine() });
    await server.close();
    // Closed with the server: the store accepts a new owner immediately afterwards.
    setEnvironment({ ...env, AGENTBROWSER_JOURNAL_INITIALIZE: undefined });
    const again = await buildServer({ engine: new FakeEngine() });
    await again.close();
  }, 60_000);
});
