// TEST-ONLY disk-full child for the concrete journal manager/adapter gates.
// A line-for-line adaptation of the production child
// (journal-sqlite-child.ts) with ONE difference: the data connection is
// capped at its bootstrap page count plus one headroom page (PRAGMA
// max_page_count — the qualification spec's sanctioned deterministic
// "max-page/disk-full" mechanism), so a write that needs a fresh page fails
// with a real storage failure while small writes still land. The cap is
// per-connection: a recovery generation spawned with the production child is
// uncapped, which is exactly the recovery property the gates assert. This
// file is excluded from the build and spawned only by the qualification
// script through the factory's childModulePath seam.
import { DatabaseSync } from 'node:sqlite';

const MAX_HANDLES = 1024;
const MAX_IN_FLIGHT = 1024;

try {
  if (typeof process.send !== 'function' || !process.connected) throw new Error('no ipc');
  // The channel connects asynchronously; the storage owner refuses to open before
  // process.connected because its disconnect seal depends on it.
  for (let spins = 0; !process.connected && spins < 100_000; spins += 1)
    await new Promise((resolve) => setImmediate(resolve));
  if (!process.connected) throw new Error('ipc channel never connected');
  const send = process.send.bind(process);
  const disconnect = process.disconnect.bind(process);
  const options = JSON.parse(process.argv[2] ?? '');

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

  // Disk-full arm: cap the DATA connection (the first COMMIT belongs to the
  // acquisition's bootstrap mutate) at its bootstrap size plus one headroom
  // page, deferred via setImmediate until the bootstrap mutate fully
  // settles. Small writes (namespace opens, fences) still fit; a write that
  // needs a fresh page beyond the cap fails with a real storage failure.
  let capped = false;
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    const result = exec.call(this, sql);
    if (!capped && sql === 'COMMIT') {
      capped = true;
      setImmediate(() => {
        try {
          const pageCount = this.prepare('PRAGMA page_count').get().page_count;
          exec.call(this, `PRAGMA max_page_count = ${pageCount + 1}`);
        } catch {
          // A failed cap leaves the child production-identical; the gate
          // fails on its own assertions rather than a broken fixture.
        }
      });
    }
    return result;
  };

  const store = openJournalSqliteStore(options);
  // Crash reacquisition: fences recorded by a dead predecessor are cleared as part
  // of this acquisition's first commit unit, before any handle can open.
  store.mutate((tx) => {
    ensureJournalSqliteRecordSchema(tx);
    tx.run('UPDATE journal_namespace SET active_fence = NULL');
    return null;
  });

  let reader;
  const readConnection = () => {
    if (!reader)
      reader = new DatabaseSync(`${options.directory}/journal.sqlite`, { readOnly: true });
    return reader;
  };
  const get =
    (connection) =>
    (sql, ...parameters) => {
      // Statement cleanup follows the owner's idiom: database.close() finalizes owned
      // statements; none escape this helper.
      return connection.prepare(sql).get(...(parameters ?? []));
    };
  const envelope = (namespaceId, ownerFence, value) => ({
    namespaceId,
    ownerFence,
    value,
  });

  const liveByNamespace = new Map();
  let inFlight = 0;

  const maybeShutdown = () => {
    if (inFlight > 0 || liveByNamespace.size > 0) return;
    try {
      reader?.close();
      reader = undefined;
    } catch {
      // A dead reader does not block the checkpoint-less close of a sealed store.
    }
    store.close();
    disconnect();
  };

  const dispatchCall = (kind, handle, namespaceId, ownerFence, value, read) => {
    let outcome;
    if (kind === 'close') {
      liveByNamespace.delete(namespaceId);
      outcome = store.mutate((tx) => {
        closeJournalSqliteNamespace(tx, namespaceId, ownerFence);
        return { kind: 'closed' };
      });
    } else if (read) {
      outcome = lookupJournalSqliteRecord(
        { get: get(readConnection()) },
        namespaceId,
        ownerFence,
        value,
        Date.now()
      );
    } else {
      outcome = store.mutate((tx) => {
        const now = Date.now();
        if (kind === 'reserveIntent')
          return reserveJournalSqliteIntent(tx, namespaceId, ownerFence, value, now);
        if (kind === 'markDispatch')
          return markJournalSqliteDispatch(tx, namespaceId, ownerFence, value, now);
        if (kind === 'commitTerminal')
          return commitJournalSqliteTerminal(tx, namespaceId, ownerFence, value, now);
        throw new Error('unreachable mutation kind');
      });
    }
    if (kind === 'close') maybeShutdown();
    return outcome;
  };

  process.on('message', (raw) => {
    // Structural guard before any field access: a malformed manager message is
    // refused as an uncorrelated fault, never a child crash.
    if (!isJournalChildRequest(raw)) {
      send({ kind: 'faulted', correlationId: -1 });
      return;
    }
    const message = raw;
    if (message.kind === 'open') {
      // Bounded CONCURRENT handles; the correlation id counts opens, not liveness.
      if (
        liveByNamespace.size >= MAX_HANDLES ||
        liveByNamespace.has(message.descriptor.namespaceId)
      ) {
        send({
          kind: 'definitely_not_opened',
          openId: message.openId,
          reason: liveByNamespace.has(message.descriptor.namespaceId) ? 'ownership' : 'capacity',
        });
        return;
      }
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
        const handle = {
          namespaceId: message.descriptor.namespaceId,
          ownerFence: openOutcome.ownerFence,
        };
        liveByNamespace.set(handle.namespaceId, handle);
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
      maybeShutdown();
      return;
    }
    if (!liveByNamespace.has(message.namespaceId)) {
      // Closed-or-never-opened namespace: production replies a definite
      // negative under the namespace identity, never a lost broadcast.
      const read = message.kind === 'lookup';
      send({
        kind: 'outcome',
        correlationId: message.correlationId,
        outcome: envelope(message.namespaceId, message.ownerFence, {
          kind: read ? 'definitely_not_read' : 'definitely_not_written',
          reason: 'closed',
        }),
      });
      return;
    }
    if (inFlight >= MAX_IN_FLIGHT) {
      send({ kind: 'faulted', correlationId: message.correlationId });
      return;
    }
    inFlight += 1;
    let outcome;
    try {
      outcome = dispatchCall(
        message.kind,
        liveByNamespace.get(message.namespaceId),
        message.namespaceId,
        message.ownerFence,
        'value' in message ? message.value : undefined,
        message.kind === 'lookup'
      );
    } catch {
      inFlight -= 1;
      // Includes anchor/fsync failures after COMMIT — and the armed
      // max-page storage failure: the call settles as faulted under its own
      // correlation, never as a lost broadcast.
      send({ kind: 'faulted', correlationId: message.correlationId });
      maybeShutdown();
      return;
    }
    inFlight -= 1;
    send({
      kind: 'outcome',
      correlationId: message.correlationId,
      outcome: envelope(message.namespaceId, message.ownerFence, outcome),
    });
    maybeShutdown();
  });

  send({ kind: 'ready' });
} catch {
  // Bootstrap failure: no storage state exists to report on. Exit nonzero so the
  // manager observes the adapter as dead instead of waiting for a ready broadcast.
  process.exit(1);
}
