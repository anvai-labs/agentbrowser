// T5 J-e: one service process with the durable journal wired, killed by its parent at a chosen
// boundary of a durable application write. Real compiled service, real SQLite store; the effect
// is an independent counter file (fsynced) the parent reads after the kill.
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { FakeEngine } from '@agentbrowser/testkit';
import { journalConfigFromEnvironment, openServiceJournal } from '../../dist/journal-config.js';
import { AgentBrowserService } from '../../dist/service.js';

const { env, mode, counterFile, operationId } = JSON.parse(process.argv[2] ?? '{}');
const hold = (phase) => {
  process.send?.({ phase });
  return new Promise(() => {}); // the parent kills this process here
};
const operator = { actor: 'operator', tenant: 'owner' };

const config = await journalConfigFromEnvironment(env);
const opened = await openServiceJournal(config);
if (mode === 'reopen') {
  process.send?.({
    phase: 'reopened',
    health: opened.journal.health,
    namespace: opened.journal.namespace.namespaceId,
  });
  await opened.close();
  process.exit(0);
}
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
          prepare: () => async () => {
            if (mode === 'before-effect') await hold('before-effect');
            const fd = openSync(counterFile, 'a');
            writeSync(fd, 'x');
            fsyncSync(fd);
            closeSync(fd);
            if (mode === 'after-effect') await hold('after-effect');
            return { status: 'committed', value: 1 };
          },
        },
      },
      receipt: async () => ({}),
    },
  ],
});
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
