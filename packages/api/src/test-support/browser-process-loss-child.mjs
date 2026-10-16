// T5 B-dur-2c: one service process with the durable journal wired, killed by its parent at a
// chosen boundary of a durable browser act (run exactly as the HTTP wrapper runs it). Real
// compiled service, real SQLite store; the effect is an independent counter file (fsynced) that
// the page's engine act appends to, read by the parent after the kill.
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FakeEngine } from '@agentbrowser/testkit';
import { journalConfigFromEnvironment, openServiceJournal } from '../../dist/journal-config.js';
import { AgentBrowserService } from '../../dist/service.js';

const { env, mode, counterFile, operationId } = JSON.parse(process.argv[2] ?? '{}');
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
          adapter: record.identity?.application?.adapterId,
          resource: record.identity?.application?.resourceId,
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
const operator = { actor: 'operator', tenant: 'owner' };

const config = await journalConfigFromEnvironment(env);
const opened = await openServiceJournal(config);
const real = opened.journal;
// The marker boundaries: hold just before the marker is written, or just after it is
// acknowledged (before the owner's recheck and the effect).
const journal = Object.freeze({
  get namespace() {
    return real.namespace;
  },
  get health() {
    return real.health;
  },
  get pending() {
    return real.pending;
  },
  reserveIntent: real.reserveIntent.bind(real),
  markDispatch: (transition, signal) => {
    const call = (async () => {
      if (mode === 'before-marker') await hold('before-marker');
      const outcome = await real.markDispatch(transition, signal);
      if (mode === 'after-marker') await hold('after-marker');
      return outcome;
    })();
    return Object.assign(call, { settled: call.then(() => undefined) });
  },
  commitTerminal: real.commitTerminal.bind(real),
  lookup: real.lookup.bind(real),
  findByOperation: real.findByOperation.bind(real),
  close: real.close.bind(real),
});
const engine = new FakeEngine();
const service = new AgentBrowserService({ engine, operationJournal: journal });
if (mode === 'reopen') {
  process.send?.({
    phase: 'reopened',
    health: real.health,
    namespace: real.namespace.namespaceId,
    rows: rows(),
  });
  await service.shutdown();
  await opened.close();
  process.exit(0);
}
const { sessionId } = await service.createSession({ tenantId: 'owner', controlMode: 'delegated' });
const run = (read) => service.authority.run(sessionId, operator, {}, read);
const { pageId } = await run(() => service.createPage(sessionId));
const page = engine.getFakePage(engine.getSessionIds()[0] ?? '', pageId);
await page.navigate({ url: 'https://example.com/form' });
page.setElements([{ role: 'button', name: 'Save' }]);
const view = await run(() => service.observe(sessionId, pageId, {}));
const ref = view.elements.find((element) => element.name === 'Save').ref;
const act = page.act.bind(page);
page.act = async (action) => {
  const fd = openSync(counterFile, 'a');
  writeSync(fd, 'x');
  fsyncSync(fd);
  closeSync(fd);
  if (mode === 'after-effect') await hold('after-effect');
  return act(action);
};
await service.authority.run(
  sessionId,
  operator,
  {
    id: operationId,
    fingerprint: `digest-${operationId}`,
    journal: {
      version: 1,
      application: { adapterId: 'browser', resourceId: 'act', bindingGeneration: pageId },
      durable: true,
      browser: true,
    },
  },
  () => service.act(sessionId, pageId, { action: 'click', target: { ref } }),
  () => false
);
process.send?.({ phase: 'done' });
await service.shutdown();
await opened.close();
process.exit(0);
