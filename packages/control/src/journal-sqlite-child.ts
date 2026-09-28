/** Production storage child for the concrete SQLite journal (J2b.2 step 2).
 * Deliberately absent from the control barrel and spawnable only by the manager:
 * one child owns one store for ALL namespace handles. Speaks exactly the frozen
 * journal-sqlite-child-protocol shapes — no test channels. The child exits when the
 * last live handle closes and all in-flight calls settle, and on parent disconnect
 * (the owner seals and exits, releasing the OS lock for a verified reacquisition).
 *
 * Store acquisition doubles as crash reacquisition: fences recorded by a dead
 * predecessor are cleared inside the acquisition transaction, so a fresh owner
 * reclaims cleanly (the process-loss matrix's SIGKILL case) while a second handle
 * for a live namespace inside one child is refused by the ownership fence.
 */
import { DatabaseSync } from 'node:sqlite';
import type { JournalChildRequest } from './journal-sqlite-child-protocol.js';
import {
  closeJournalSqliteNamespace,
  commitJournalSqliteTerminal,
  ensureJournalSqliteRecordSchema,
  lookupJournalSqliteRecord,
  markJournalSqliteDispatch,
  openJournalSqliteRecords,
  reserveJournalSqliteIntent,
} from './journal-sqlite-records.js';
import type { JournalSqliteTransaction } from './journal-sqlite-store.js';

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

  const { openJournalSqliteStore } = await import('./journal-sqlite-store.js');
  const store = openJournalSqliteStore(options);
  // Crash reacquisition: fences recorded by a dead predecessor are cleared as part
  // of this acquisition's first commit unit, before any handle can open.
  store.mutate((tx: JournalSqliteTransaction) => {
    ensureJournalSqliteRecordSchema(tx);
    tx.run('UPDATE journal_namespace SET active_fence = NULL');
    return null;
  });

  let reader: DatabaseSync | undefined;
  const readConnection = () => {
    if (!reader)
      reader = new DatabaseSync(`${options.directory}/journal.sqlite`, { readOnly: true });
    return reader;
  };
  const get =
    (connection: DatabaseSync) =>
    (sql: string, ...parameters: unknown[]) => {
      // Statement cleanup follows the owner's idiom: database.close() finalizes owned
      // statements; none escape this helper.
      return connection.prepare(sql).get(...(parameters as never[])) as
        | Record<string, unknown>
        | undefined;
    };
  const envelope = (namespaceId: string, ownerFence: string, value: unknown) => ({
    namespaceId,
    ownerFence,
    value,
  });

  interface LiveHandle {
    readonly namespaceId: string;
    readonly ownerFence: string;
  }
  const liveByNamespace = new Map<string, LiveHandle>();
  let openSequence = 0;
  let inFlight = 0;

  const maybeShutdown = () => {
    if (inFlight > 0 || liveByNamespace.size > 0) return;
    store.close();
    disconnect();
  };

  const dispatchCall = (
    kind: string,
    handle: LiveHandle,
    namespaceId: string,
    ownerFence: string,
    value: unknown,
    read: boolean
  ): unknown => {
    let outcome: unknown;
    if (kind === 'close') {
      liveByNamespace.delete(namespaceId);
      outcome = store.mutate((tx: JournalSqliteTransaction) => {
        closeJournalSqliteNamespace(tx, namespaceId, ownerFence);
        return { kind: 'closed' };
      });
    } else if (read) {
      outcome = lookupJournalSqliteRecord(
        { get: get(readConnection()) },
        namespaceId,
        ownerFence,
        value as Parameters<typeof lookupJournalSqliteRecord>[3],
        Date.now()
      );
    } else {
      outcome = store.mutate((tx: JournalSqliteTransaction) => {
        const now = Date.now();
        if (kind === 'reserveIntent')
          return reserveJournalSqliteIntent(
            tx,
            namespaceId,
            ownerFence,
            value as Parameters<typeof reserveJournalSqliteIntent>[3],
            now
          );
        if (kind === 'markDispatch')
          return markJournalSqliteDispatch(
            tx,
            namespaceId,
            ownerFence,
            value as Parameters<typeof markJournalSqliteDispatch>[3],
            now
          );
        if (kind === 'commitTerminal')
          return commitJournalSqliteTerminal(
            tx,
            namespaceId,
            ownerFence,
            value as Parameters<typeof commitJournalSqliteTerminal>[3],
            now
          );
        throw new Error('unreachable mutation kind');
      });
    }
    if (kind === 'close') maybeShutdown();
    return outcome;
  };

  process.on('message', (message: JournalChildRequest) => {
    if (message.kind === 'open') {
      if (openSequence >= MAX_HANDLES || liveByNamespace.has(message.descriptor.namespaceId)) {
        send({
          kind: 'definitely_not_opened',
          openId: message.openId,
          reason: liveByNamespace.has(message.descriptor.namespaceId) ? 'ownership' : 'capacity',
        });
        return;
      }
      let openOutcome:
        | { kind: 'opened'; ownerFence: string }
        | { kind: 'refused'; reason: 'ownership' | 'configuration' | 'capacity' | 'expired' }
        | undefined;
      try {
        openOutcome = store.mutate((tx: JournalSqliteTransaction) => {
          const result = openJournalSqliteRecords(tx, message.descriptor, Date.now());
          return result.kind === 'opened'
            ? { kind: 'opened' as const, ownerFence: result.ownerFence }
            : { kind: 'refused' as const, reason: result.reason };
        });
      } catch {
        send({ kind: 'uncertain', openId: message.openId, reason: 'io' });
        return;
      }
      if (openOutcome.kind === 'opened') {
        openSequence += 1;
        const handle: LiveHandle = {
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
        send({
          kind: 'definitely_not_opened',
          openId: message.openId,
          reason: openOutcome.reason,
        });
      } else {
        send({ kind: 'uncertain', openId: message.openId, reason: 'io' });
      }
      return;
    }
    const handle = liveByNamespace.get(message.namespaceId);
    if (!handle || handle.ownerFence !== message.ownerFence) {
      if (message.kind === 'close') {
        send({
          kind: 'outcome',
          correlationId: message.correlationId,
          outcome: envelope(message.namespaceId, message.ownerFence, { kind: 'closed' }),
        });
        maybeShutdown();
        return;
      }
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
    let outcome: unknown;
    try {
      outcome = dispatchCall(
        message.kind,
        handle,
        message.namespaceId,
        message.ownerFence,
        'value' in message ? message.value : undefined,
        message.kind === 'lookup'
      );
    } catch {
      inFlight -= 1;
      // Includes anchor/fsync failures after COMMIT: the call settles as faulted
      // under its own correlation, never as a lost broadcast.
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
