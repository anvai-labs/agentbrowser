// T5 J-e: one service process with the durable journal wired, killed by its parent at a chosen
// boundary of a durable application write. Real compiled service, real SQLite store; the effect
// is an independent counter file (fsynced) the parent reads after the kill.
import { closeSync, fsyncSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FakeEngine } from '@agentbrowser/testkit';
import { journalConfigFromEnvironment, openServiceJournal } from '../../dist/journal-config.js';
import { AgentBrowserService } from '../../dist/service.js';

const { env, mode, counterFile, operationId, signalFile } = JSON.parse(process.argv[2] ?? '{}');
/** The store's rows, read-only, while this process is still alive at the hold point. */
const rows = () => {
  const database = new DatabaseSync(join(env.AGENTBROWSER_JOURNAL_DIR, 'journal.sqlite'), {
    readOnly: true,
  });
  try {
    return database
      .prepare('SELECT revision, record FROM journal_record')
      .all()
      .map((row) => {
        const record = JSON.parse(row.record);
        return {
          revision: Number(row.revision),
          dispatched: record.dispatched,
          terminal: record.terminal,
        };
      });
  } finally {
    database.close();
  }
};
const hold = (phase) => {
  process.send?.({ phase, rows: rows() });
  return new Promise(() => {}); // the parent kills this process here
};
/** For synchronous hold points (prepare): signal through a file, then block the thread. */
const holdSync = (phase) => {
  writeFileSync(signalFile, JSON.stringify({ phase, rows: rows() }));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const operator = { actor: 'operator', tenant: 'owner' };

const config = await journalConfigFromEnvironment(env);
const opened = await openServiceJournal(config);
const service = new AgentBrowserService({
  engine: new FakeEngine(),
  operationJournal: opened.journal,
  applicationAdapters: [
    {
      id: 'counter',
      authorize: () => true,
      operations: {
        add: {
          mode: 'write',
          prepare: () => {
            // Called after the intent is acknowledged and before the dispatch marker.
            if (mode === 'before-marker') holdSync('before-marker');
            return async () => {
              if (mode === 'before-effect') await hold('before-effect');
              const fd = openSync(counterFile, 'a');
              writeSync(fd, 'x');
              fsyncSync(fd);
              closeSync(fd);
              if (mode === 'after-effect') await hold('after-effect');
              return { status: 'committed', value: 1 };
            };
          },
        },
      },
      receipt: async () => ({}),
    },
  ],
});
if (mode === 'reopen') {
  // The full service (adapters registered) starts on the reopened namespace and executes nothing.
  process.send?.({
    phase: 'reopened',
    health: opened.journal.health,
    namespace: opened.journal.namespace.namespaceId,
    rows: rows(),
  });
  await service.shutdown();
  await opened.close();
  process.exit(0);
}
const { sessionId } = await service.createSession({ tenantId: 'owner', controlMode: 'delegated' });
service.applicationBind(sessionId, operator, { adapter: 'counter', resource: 'account' });
if (mode === 'before-intent') await hold('before-intent');
await service.applicationExecute(sessionId, operator, {
  operation: 'add',
  input: 1,
  operationId,
  expectedVersion: 0,
  executionRequirement: 'durable',
});
if (mode === 'after-terminal') await hold('after-terminal');
process.send?.({ phase: 'done' });
await service.shutdown();
await opened.close();
process.exit(0);
