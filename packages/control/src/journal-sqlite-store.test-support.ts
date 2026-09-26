// Real child fixture only: no fault switches are exposed by production storage.
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import type { JournalSqliteTransaction } from './journal-sqlite-store.js';

assert(process.send && process.disconnect);
const send = process.send.bind(process);
const disconnect = process.disconnect.bind(process);
const options = JSON.parse(process.argv[2] ?? '');
const fault = process.argv[3];
let armed = fault === 'init_after_commit';
const barrier = (phase: string) => {
  send({ phase });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql: string) {
  if (armed && fault === 'before_commit' && sql === 'COMMIT') barrier(fault);
  const result = exec.call(this, sql);
  if (armed && (fault === 'after_commit' || fault === 'init_after_commit') && sql === 'COMMIT')
    barrier(fault);
  return result;
};
const mutableFs = (await import('node:fs')).default;
const rename = mutableFs.renameSync;
mutableFs.renameSync = (...args) => {
  if (armed && fault === 'anchor_error') throw new Error('PRIVATE_SENTINEL');
  return rename(...args);
};
const sync = mutableFs.fsyncSync;
mutableFs.fsyncSync = (fd) => {
  const stat = mutableFs.fstatSync(fd);
  const directory = mutableFs.statSync(options.anchorDirectory);
  if (
    armed &&
    stat.isDirectory() &&
    ((fault === 'directory_sync_error' &&
      stat.ino === directory.ino &&
      stat.dev === directory.dev) ||
      (fault === 'store_directory_sync_error' && stat.ino !== directory.ino))
  )
    throw new Error('PRIVATE_SENTINEL');
  return sync(fd);
};
syncBuiltinESMExports();
try {
  const { openJournalSqliteStore } = await import('../dist/journal-sqlite-store.js');
  const store = openJournalSqliteStore(options);
  let reader: DatabaseSync | undefined;
  send({ phase: 'opened', witness: store.witness });
  process.on('message', (message: string) => {
    try {
      if (message === 'close') {
        store.close();
        disconnect();
      } else if (message === 'hold_reader') {
        reader = new DatabaseSync(`${options.directory}/journal.sqlite`, { readOnly: true });
        reader.exec('BEGIN');
        reader.prepare('SELECT * FROM journal_store').all();
        send({ phase: 'reader_held' });
      } else if (message === 'duplicate') {
        openJournalSqliteStore({ ...options, initialize: false });
      } else if (message === 'callback_error') {
        store.mutate((database) => {
          database.exec('CREATE TABLE rolled_back(value INTEGER) STRICT');
          throw new Error('PRIVATE_SENTINEL');
        });
      } else if (message === 'retained') {
        let retained: JournalSqliteTransaction | undefined;
        store.mutate((database) => {
          retained = database;
        });
        assert(retained);
        retained.exec('CREATE TABLE escaped(value INTEGER) STRICT');
        send({ phase: 'escaped' });
      } else if (message === 'async_escape') {
        store.mutate((transaction) => {
          const later = Promise.resolve().then(() =>
            transaction.exec('CREATE TABLE escaped(value INTEGER) STRICT')
          );
          void later.catch((error) => send({ phase: 'late_refused', error: error.message }));
          return later;
        });
      } else if (message === 'return_capability') {
        store.mutate((transaction) => transaction);
        send({ phase: 'escaped' });
      } else if (message === 'microtask') {
        store.mutate((transaction) => {
          queueMicrotask(() => {
            try {
              transaction.exec('CREATE TABLE escaped(value INTEGER) STRICT');
              send({ phase: 'escaped' });
            } catch (error) {
              send({ phase: 'late_refused', error: (error as Error).message });
            }
          });
        });
      } else if (message === 'pragma_escape' || message === 'attach_escape') {
        store.mutate((transaction) =>
          transaction.exec(
            message === 'pragma_escape' ? 'PRAGMA synchronous=OFF' : "ATTACH ':memory:' AS escaped"
          )
        );
        send({ phase: 'escaped' });
      } else if (message === 'transaction_escape') {
        store.mutate((database) => {
          database.exec('COMMIT');
        });
        send({ phase: 'escaped' });
      } else if (message === 'witness_escape') {
        store.mutate((database) => {
          database.exec('DELETE FROM journal_store');
        });
        send({ phase: 'escaped' });
      } else if (message === 'mutate') {
        armed = true;
        store.mutate((database) => {
          database.exec('CREATE TABLE IF NOT EXISTS facts(value INTEGER NOT NULL) STRICT');
          database.run('INSERT INTO facts VALUES (?)', 7);
        });
        if (fault === 'after_anchor') barrier(fault);
        send({ phase: 'ack', witness: store.witness });
      } else if (message === 'inspect') {
        const database = new DatabaseSync(`${options.directory}/journal.sqlite`, {
          readOnly: true,
        });
        const count = database.prepare('SELECT count(*) AS count FROM facts').get();
        database.close();
        send({ phase: 'observed', count: count?.count });
      }
    } catch (error) {
      send({ phase: 'error', error: (error as Error).message });
    }
  });
} catch (error) {
  send({ phase: 'refused', error: (error as Error).message });
  disconnect();
}
