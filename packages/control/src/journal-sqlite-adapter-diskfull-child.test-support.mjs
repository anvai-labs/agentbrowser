// TEST-ONLY disk-full child for the concrete journal manager/adapter gates.
// Speaks exactly the frozen production protocol; the ONLY difference from the
// production child is that the data connection is capped at its bootstrap size
// (PRAGMA max_page_count, the qualification spec's sanctioned deterministic
// "max-page/disk-full" mechanism) and the remaining free pages are consumed by
// a pad table, so the next owner write that needs a fresh page fails with a
// real SQLITE_FULL. The cap is per-connection: a fresh generation spawned with
// the production child is uncapped, which is exactly the recovery property the
// gates assert. This file is excluded from the build and spawned only by the
// qualification script through the factory's childModulePath seam.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

assert(process.send && process.disconnect);
for (let spins = 0; !process.connected && spins < 100_000; spins += 1)
  await new Promise((resolve) => setImmediate(resolve));
assert(process.connected);
const send = process.send.bind(process);
const options = JSON.parse(process.argv[2] ?? '');
// argv[3] (via the adapter's childArgv seam): {mode:'nocap'} disables the
// disk-full cap for recovery generations that must run instrumented but
// uncapped.
const arm = JSON.parse(process.argv[3] ?? '{}');

const { openJournalSqliteStore } = await import('../dist/journal-sqlite-store.js');
const {
  closeJournalSqliteNamespace,
  commitJournalSqliteTerminal,
  ensureJournalSqliteRecordSchema,
  lookupJournalSqliteRecord,
  markJournalSqliteDispatch,
  openJournalSqliteRecords,
  reserveJournalSqliteIntent,
} = await import('../dist/journal-sqlite-records.js');
const { isJournalChildRequest } = await import('../dist/journal-sqlite-child-protocol.js');

// Cap the DATA connection (the first COMMIT belongs to the acquisition's
// bootstrap mutate) at its bootstrap size PLUS a small headroom, deferred
// until the bootstrap mutate fully settles: small writes (namespace opens,
// fences) still fit, while any bulk write — the gates' fault intents —
// needs fresh pages and hits a real SQLITE_FULL. The cap is per-connection,
// so the recovery generation with the production child is uncapped.
let capped = arm.mode === 'nocap';
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  const result = exec.call(this, sql);
  if (!capped && sql === 'COMMIT') {
    capped = true;
    setImmediate(() => {
      try {
        const pageCount = this.prepare('PRAGMA page_count').get().page_count;
        exec.call(this, `PRAGMA max_page_count = ${pageCount + 1}`);
      } catch (error) {}
    });
  }
  return result;
};

const store = openJournalSqliteStore(options);
store.mutate((tx) => {
  ensureJournalSqliteRecordSchema(tx);
  return null;
});

let reader;
const readConnection = () => {
  if (!reader) reader = new DatabaseSync(`${options.directory}/journal.sqlite`, { readOnly: true });
  return reader;
};
const get = (sql, ...parameters) => {
  const prepared = readConnection().prepare(sql);
  try {
    return prepared.get(...(parameters ?? []));
  } finally {
    prepared.close?.();
  }
};
const envelope = (namespaceId, ownerFence, value) => ({ namespaceId, ownerFence, value });

process.on('message', (raw) => {
  if (!isJournalChildRequest(raw)) return;
  const message = raw;
  if (message.kind === 'open') {
    const openId = message.openId;
    let openOutcome;
    try {
      openOutcome = store.mutate((tx) => {
        const result = openJournalSqliteRecords(tx, message.descriptor, Date.now());
        return result.kind === 'opened'
          ? { kind: 'opened', ownerFence: result.ownerFence }
          : { kind: 'refused', reason: result.reason };
      });
    } catch {
      send({ kind: 'uncertain', openId: message.openId, reason: 'io' });
      return;
    }
    if (openOutcome.kind === 'opened') {
      send({
        kind: 'opened',
        openId: message.openId,
        namespace: message.descriptor,
        ownerFence: openOutcome.ownerFence,
      });
    } else if (openOutcome.kind === 'refused') {
      send({ kind: 'definitely_not_opened', openId: message.openId, reason: openOutcome.reason });
    } else {
      send({ kind: 'uncertain', openId: message.openId, reason: 'io' });
    }
    return;
  }
  if (message.kind === 'lookup') {
    const found = lookupJournalSqliteRecord(
      { get },
      message.namespaceId,
      message.ownerFence,
      message.value,
      Date.now()
    );
    send({
      kind: 'outcome',
      correlationId: message.correlationId,
      outcome: envelope(message.namespaceId, message.ownerFence, found),
    });
    return;
  }
  if (message.kind === 'close') {
    const closed = store.mutate((tx) => {
      closeJournalSqliteNamespace(tx, message.namespaceId, message.ownerFence);
      return { kind: 'closed' };
    });
    send({
      kind: 'outcome',
      correlationId: message.correlationId,
      outcome: envelope(message.namespaceId, message.ownerFence, closed),
    });
    return;
  }
  let outcome;
  try {
    outcome = store.mutate((tx) => {
      const now = Date.now();
      if (message.kind === 'reserveIntent')
        return reserveJournalSqliteIntent(
          tx,
          message.namespaceId,
          message.ownerFence,
          message.value,
          now
        );
      if (message.kind === 'markDispatch')
        return markJournalSqliteDispatch(
          tx,
          message.namespaceId,
          message.ownerFence,
          message.value,
          now
        );
      if (message.kind === 'commitTerminal')
        return commitJournalSqliteTerminal(
          tx,
          message.namespaceId,
          message.ownerFence,
          message.value,
          now
        );
      throw new Error('unreachable mutation kind');
    });
  } catch {
    // Production semantics: a failing mutation (SQLITE_FULL included) settles
    // as faulted under its own correlation — never a lost broadcast.
    send({ kind: 'faulted', correlationId: message.correlationId });
    return;
  }
  send({
    kind: 'outcome',
    correlationId: message.correlationId,
    outcome: envelope(message.namespaceId, message.ownerFence, outcome),
  });
});

send({ kind: 'ready' });
