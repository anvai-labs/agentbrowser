// Real child fixture for the record state machine: hosts the storage owner and the
// frozen-v1 record schema, speaks the production IPC protocol, and exposes strictly
// test-only channels (clock, observation, ownership steal, fault arming). No fault
// switches exist in production storage; error text never crosses the call path.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { JournalSqliteTransaction } from './journal-sqlite-store.js';

assert(process.send && process.disconnect);
// The IPC channel connects asynchronously: the storage owner refuses to open before
// process.connected because its disconnect seal depends on the channel, so the child
// must not reach the store open during that window.
for (let spins = 0; !process.connected && spins < 100_000; spins += 1)
  await new Promise((resolve) => setImmediate(resolve));
assert(process.connected);
const send = process.send.bind(process);
const disconnect = process.disconnect.bind(process);
const options = JSON.parse(process.argv[2] ?? '');

let clock = 1_000;
interface LiveHandle {
  readonly namespaceId: string;
  readonly ownerFence: string;
  closed: boolean;
}
const handles = new Map<number, LiveHandle>();
type FaultPoint = 'before_write' | 'after_commit' | 'never_settles';
let armed: { method: string; point: FaultPoint } | undefined;

try {
  const { openJournalSqliteStore } = await import('../dist/journal-sqlite-store.js');
  const {
    closeJournalSqliteNamespace,
    commitJournalSqliteTerminal,
    lookupJournalSqliteRecord,
    markJournalSqliteDispatch,
    observeJournalSqliteNamespace,
    openJournalSqliteRecords,
    reserveJournalSqliteIntent,
  } = await import('../dist/journal-sqlite-records.js');
  const { isJournalChildRequest } = await import('../dist/journal-sqlite-child-protocol.js');
  const store = openJournalSqliteStore(options);
  let reader: DatabaseSync | undefined;
  const readConnection = () => {
    if (!reader)
      reader = new DatabaseSync(`${options.directory}/journal.sqlite`, { readOnly: true });
    return reader;
  };
  const get =
    (connection: DatabaseSync) =>
    (sql: string, ...parameters: unknown[]) => {
      const prepared = connection.prepare(sql);
      try {
        return prepared.get(...(parameters as never[])) as Record<string, unknown> | undefined;
      } finally {
        prepared.close?.();
      }
    };
  const all =
    (connection: DatabaseSync) =>
    (sql: string, ...parameters: unknown[]) => {
      const prepared = connection.prepare(sql);
      try {
        return prepared.all(...(parameters as never[])) as Record<string, unknown>[];
      } finally {
        prepared.close?.();
      }
    };
  const envelope = (namespaceId: string, ownerFence: string, value: unknown) => ({
    namespaceId,
    ownerFence,
    value,
  });
  const faulted = (correlationId: number) => ({ kind: 'faulted', correlationId });
  const takeFault = (method: string): FaultPoint | undefined => {
    if (armed?.method !== method) return undefined;
    const point = armed.point;
    armed = undefined;
    return point;
  };

  process.on('message', (message: unknown) => {
    try {
      if (typeof message === 'object' && message !== null && 'test' in message) {
        const test = message as Record<string, unknown>;
        if (test.test === 'ready') {
          send({ test: 'ready_ack' });
        } else if (test.test === 'advance') {
          clock += test.milliseconds as number;
          send({ test: 'advanced', clock });
        } else if (test.test === 'observe') {
          const snapshot = observeJournalSqliteNamespace(
            { get: get(readConnection()), all: all(readConnection()) },
            test.namespaceId as string
          );
          send({ test: 'observed', snapshot });
        } else if (test.test === 'release_ownership') {
          store.mutate((tx: JournalSqliteTransaction) => {
            tx.run(
              'UPDATE journal_namespace SET active_fence = NULL WHERE namespace_id = ?',
              test.namespaceId
            );
            return null;
          });
          send({ test: 'released' });
        } else if (test.test === 'arm') {
          armed = { method: test.method as string, point: test.point as FaultPoint };
          send({ test: 'armed' });
        } else if (test.test === 'inspect_schema') {
          const connection = readConnection();
          const tables = connection
            .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all() as { name: string; sql: string }[];
          const columns = connection.prepare('PRAGMA table_info(journal_record)').all() as {
            name: string;
          }[];
          const stored = connection.prepare('SELECT record FROM journal_record').all() as {
            record: string;
          }[];
          send({ test: 'schema', tables, columns, stored });
        } else if (test.test === 'dispose') {
          store.close();
          send({ test: 'disposed' });
          disconnect();
        }
        return;
      }
      if (!isJournalChildRequest(message)) {
        send({ kind: 'faulted', correlationId: -1 });
        return;
      }
      if (message.kind === 'open') {
        const openId = message.openId;
        const outcome = store.mutate((tx) => {
          const result = openJournalSqliteRecords(tx, message.descriptor, clock);
          return result.kind === 'opened' ? result : { refused: result.reason };
        });
        if (outcome.kind === 'opened') {
          handles.set(openId, {
            namespaceId: message.descriptor.namespaceId,
            ownerFence: outcome.ownerFence,
            closed: false,
          });
          send({
            kind: 'opened',
            openId,
            namespace: message.descriptor,
            ownerFence: outcome.ownerFence,
          });
        } else if ('refused' in outcome) {
          send({ kind: 'definitely_not_opened', openId, reason: outcome.refused });
        } else {
          send({ kind: 'uncertain', openId, reason: 'io' });
        }
        return;
      }
      const correlationId = message.correlationId;
      const handle = [...handles.values()].find(
        (candidate) =>
          candidate.namespaceId === message.namespaceId &&
          candidate.ownerFence === message.ownerFence
      );
      const read = message.kind === 'lookup';
      if (!handle || handle.closed) {
        send({
          kind: 'outcome',
          correlationId,
          outcome: envelope(message.namespaceId, message.ownerFence, {
            kind: read ? 'definitely_not_read' : 'definitely_not_written',
            reason: 'closed',
          }),
        });
        return;
      }
      const fault = takeFault(message.kind);
      if (fault === 'before_write') {
        send(faulted(correlationId));
        return;
      }
      if (fault === 'never_settles') return; // the call stays unresolved; storage untouched
      let outcome: unknown;
      if (message.kind === 'close') {
        handle.closed = true;
        outcome = store.mutate((tx) => {
          closeJournalSqliteNamespace(tx, message.namespaceId, message.ownerFence);
          return { kind: 'closed' };
        });
      } else if (read) {
        outcome = lookupJournalSqliteRecord(
          { get: get(readConnection()) },
          message.namespaceId,
          message.ownerFence,
          message.value as Parameters<typeof lookupJournalSqliteRecord>[3],
          clock
        );
      } else {
        outcome = store.mutate((tx) => {
          if (message.kind === 'reserveIntent')
            return reserveJournalSqliteIntent(
              tx,
              message.namespaceId,
              message.ownerFence,
              message.value as Parameters<typeof reserveJournalSqliteIntent>[3],
              clock
            );
          if (message.kind === 'markDispatch')
            return markJournalSqliteDispatch(
              tx,
              message.namespaceId,
              message.ownerFence,
              message.value as Parameters<typeof markJournalSqliteDispatch>[3],
              clock
            );
          if (message.kind === 'commitTerminal')
            return commitJournalSqliteTerminal(
              tx,
              message.namespaceId,
              message.ownerFence,
              message.value as Parameters<typeof commitJournalSqliteTerminal>[3],
              clock
            );
          throw new Error('unreachable mutation kind');
        });
      }
      if (fault === 'after_commit') {
        send(faulted(correlationId));
        return;
      }
      send({
        kind: 'outcome',
        correlationId,
        outcome: envelope(message.namespaceId, message.ownerFence, outcome),
      });
    } catch {
      send({ kind: 'faulted', correlationId: -1 });
    }
  });
} catch (error) {
  send({ phase: 'child_refused', error: (error as Error).stack ?? (error as Error).message });
  disconnect();
}
