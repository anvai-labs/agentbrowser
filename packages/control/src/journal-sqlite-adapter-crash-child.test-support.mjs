// TEST-ONLY crash-barrier child for the concrete journal manager/adapter gates.
// Speaks exactly the frozen production protocol; the ONLY difference from the
// production child is that a reserveIntent COMMIT and the post-mutate ACK can block
// forever at an armed barrier, so the qualification can SIGKILL the child while a
// call is unresolved at a deterministic point. The arm is SCOPED to the faulted
// method's own dispatch (set when that message arrives, cleared when it settles) —
// an unscoped COMMIT patch fires on this child's own bootstrap commits and hangs
// generation 1 pre-ready, which is a test-support bug, not a product state. Arming
// arrives at spawn through argv[3], never through the frozen protocol; this file is
// excluded from the build and spawned only by the qualification script through the
// factory's childModulePath/childArgv seams.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

assert(process.send && process.disconnect);
for (let spins = 0; !process.connected && spins < 100_000; spins += 1)
  await new Promise((resolve) => setImmediate(resolve));
assert(process.connected);
const send = process.send.bind(process);
const options = JSON.parse(process.argv[2] ?? '');
// { method: 'reserveIntent', point: 'before_commit' | 'after_commit' | 'after_anchor' | 'never_settles' }
const fault = JSON.parse(process.argv[3] ?? '{}');

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

// Scoped arm: true only while the faulted method's own dispatch is inside the
// owner mutate. The patch must never fire on this child's bootstrap commits.
let dispatchArmed = false;
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (dispatchArmed && sql === 'COMMIT') {
    if (fault.point === 'before_commit') barrier(fault.point);
    const result = exec.call(this, sql);
    if (fault.point === 'after_commit') barrier(fault.point);
    return result;
  }
  return exec.call(this, sql);
};
const barrier = (phase) => {
  send({ barrier: phase });
  // Nobody wakes this: the qualification's SIGKILL is the continuation.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
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
    send({
      kind: 'outcome',
      correlationId: message.correlationId,
      outcome: envelope(message.namespaceId, message.ownerFence, { kind: 'closed' }),
    });
    return;
  }
  const dropsReplies = fault.point === 'never_settles';
  if (dropsReplies) {
    // The mutation still executes (storage state after the kill is the point);
    // only the reply is withheld so the caller times out.
    store.mutate((tx) => {
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
    return;
  }
  const isFaultedDispatch = message.kind === fault.method;
  if (isFaultedDispatch && fault.point === 'after_anchor') {
    // Anchor fully replaced; block before the reply so the caller is unresolved.
    const outcome = store.mutate((tx) => dispatchFaulted(tx, message));
    barrier(fault.point);
    send({
      kind: 'outcome',
      correlationId: message.correlationId,
      outcome: envelope(message.namespaceId, message.ownerFence, outcome),
    });
    return;
  }
  const outcome = store.mutate((tx) => {
    // Armed stays true through the owner's COMMIT — the barrier must fire on the
    // commit itself; this child is single-shot (the gate SIGKILLs it).
    if (isFaultedDispatch) dispatchArmed = true;
    return dispatchFaulted(tx, message);
  });
  send({
    kind: 'outcome',
    correlationId: message.correlationId,
    outcome: envelope(message.namespaceId, message.ownerFence, outcome),
  });

  function dispatchFaulted(tx, request) {
    const now = Date.now();
    if (request.kind === 'reserveIntent')
      return reserveJournalSqliteIntent(
        tx,
        request.namespaceId,
        request.ownerFence,
        request.value,
        now
      );
    if (request.kind === 'markDispatch')
      return markJournalSqliteDispatch(
        tx,
        request.namespaceId,
        request.ownerFence,
        request.value,
        now
      );
    if (request.kind === 'commitTerminal')
      return commitJournalSqliteTerminal(
        tx,
        request.namespaceId,
        request.ownerFence,
        request.value,
        now
      );
    throw new Error('unreachable faulted dispatch kind');
  }
});

send({ kind: 'ready' });
