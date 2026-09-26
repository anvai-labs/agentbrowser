/** Internal storage-child primitive. Deliberately absent from the control barrel.
 * Owns storage only; the journal adapter will own record/CAS/namespace semantics.
 */
import { randomUUID } from 'node:crypto';
import {
  constants,
  type Stats,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
  constants as sqliteConstants,
} from 'node:sqlite';
import { journalData } from './journal-record.js';

// Local declaration for the optional Node 24 API; the workspace keeps Node 22 types.
type Authorizer = (action: number, arg1: string | null, arg2: string | null) => number;
type OwnedDatabase = DatabaseSync & { setAuthorizer(callback: Authorizer | null): void };
export interface JournalSqliteTransaction {
  exec(sql: string): void;
  run(sql: string, ...parameters: SQLInputValue[]): void;
  get(sql: string, ...parameters: SQLInputValue[]): Record<string, unknown> | undefined;
}
function statement<T>(database: DatabaseSync, sql: string, use: (value: StatementSync) => T): T {
  // Node 24's database.close() finalizes owned statements; none escape this helper.
  return use(database.prepare(sql));
}
function row(database: DatabaseSync, sql: string, ...parameters: SQLInputValue[]) {
  return statement(database, sql, (prepared) => prepared.get(...parameters));
}
function run(database: DatabaseSync, sql: string, ...parameters: SQLInputValue[]) {
  return statement(database, sql, (prepared) => prepared.run(...parameters));
}

export interface JournalStoreWitness {
  readonly formatVersion: 1;
  readonly storeUUID: string;
  readonly restoreGeneration: string;
  readonly commitSeq: number;
  readonly commitNonce: string;
}
export interface JournalSqliteStoreOptions {
  /** Existing canonical, private, local directories, provisioned by the operator. */
  directory: string;
  anchorDirectory: string;
  restoreGeneration: string;
  /** Explicit first initialization only. Never repairs an existing partial pair. */
  initialize?: boolean;
}
const codes = sqliteConstants as unknown as Record<string, number>;
const forbidden = new Set(
  ['SQLITE_TRANSACTION', 'SQLITE_SAVEPOINT', 'SQLITE_PRAGMA', 'SQLITE_ATTACH', 'SQLITE_DETACH'].map(
    (key) => codes[key]
  )
);
const liveDirectories = new Set<string>();
const unavailable = () => new Error('Journal store unavailable');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function witness(input: unknown): Readonly<JournalStoreWitness> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw unavailable();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !==
      'commitNonce,commitSeq,formatVersion,restoreGeneration,storeUUID' ||
    value.formatVersion !== 1 ||
    typeof value.storeUUID !== 'string' ||
    !uuid.test(value.storeUUID) ||
    typeof value.commitNonce !== 'string' ||
    !uuid.test(value.commitNonce) ||
    typeof value.restoreGeneration !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.restoreGeneration) ||
    !Number.isSafeInteger(value.commitSeq) ||
    (value.commitSeq as number) < 0
  )
    throw unavailable();
  return Object.freeze({
    formatVersion: 1,
    storeUUID: value.storeUUID,
    restoreGeneration: value.restoreGeneration,
    commitSeq: value.commitSeq as number,
    commitNonce: value.commitNonce,
  });
}
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function same(left: Stats, right: Stats) {
  if (
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    (!left.isDirectory() && left.nlink !== right.nlink)
  )
    throw unavailable();
}
function inspect(path: string, directory = false): Stats {
  const stat = lstatSync(path);
  if (
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
  )
    throw unavailable();
  return stat;
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function createFile(path: string) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function canonicalDirectory(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path)
    throw unavailable();
  return inspect(path, true);
}
function contains(parent: string, child: string) {
  const part = relative(parent, child);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
function readAnchor(path: string): Readonly<JournalStoreWitness> {
  const before = inspect(path);
  if (before.size > 1024) throw unavailable();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    same(before, fstatSync(fd));
    const bytes = Buffer.alloc(1025);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 1024 || count !== before.size) throw unavailable();
    const raw = bytes.subarray(0, count).toString('utf8');
    const value = witness(JSON.parse(raw));
    if (raw !== JSON.stringify(value)) throw unavailable();
    return value;
  } finally {
    closeSync(fd);
  }
}

/** Synchronous calls are legal only inside a dedicated IPC storage child.
 * Callbacks are trusted adapter code using a revocable SQL facade. No business
 * effects belong here; results reuse the bounded journal-data snapshot contract.
 * Any transaction failure seals the owner until explicit close/reopen investigation.
 */
export function openJournalSqliteStore(input: JournalSqliteStoreOptions) {
  const options = Object.freeze({ ...input });
  let owner: DatabaseSync | undefined;
  let database: DatabaseSync | undefined;
  let anchorOwner: DatabaseSync | undefined;
  let sealed = false;
  let closed = false;
  let mutating = false;
  let disconnect: (() => void) | undefined;
  let registered = false;
  try {
    if (typeof process.send !== 'function' || !process.connected || process.platform === 'win32')
      throw unavailable();
    if (
      typeof options.restoreGeneration !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(options.restoreGeneration) ||
      typeof (DatabaseSync.prototype as OwnedDatabase).setAuthorizer !== 'function'
    )
      throw unavailable();
    const directoryStat = canonicalDirectory(options.directory);
    const anchorDirectoryStat = canonicalDirectory(options.anchorDirectory);
    if (
      contains(options.directory, options.anchorDirectory) ||
      contains(options.anchorDirectory, options.directory)
    )
      throw unavailable();
    if (liveDirectories.has(options.directory) || liveDirectories.has(options.anchorDirectory))
      throw unavailable();
    liveDirectories.add(options.directory);
    liveDirectories.add(options.anchorDirectory);
    registered = true;
    const ownerPath = join(options.directory, 'owner.sqlite');
    const dataPath = join(options.directory, 'journal.sqlite');
    const anchorPath = join(options.anchorDirectory, 'commit.json');
    const anchorOwnerPath = join(options.anchorDirectory, 'owner.sqlite');
    const temporaryPath = join(options.anchorDirectory, 'commit.pending');
    const initialize = options.initialize === true;
    for (const path of [ownerPath, dataPath, anchorOwnerPath]) {
      for (const suffix of ['-wal', '-shm', '-journal']) {
        if (exists(path + suffix)) {
          if (initialize) throw unavailable();
          inspect(path + suffix);
        }
      }
    }
    // Exclusive file creation serializes first initialization. Existing owner-only
    // layouts are evidence of interruption and must never be silently repaired.
    if (initialize) {
      if (exists(dataPath) || exists(anchorPath) || exists(temporaryPath)) throw unavailable();
      createFile(ownerPath);
      syncDirectory(options.directory);
    }
    const ownerStat = inspect(ownerPath);
    const acquire = (path: string) => {
      const connection = new DatabaseSync(path);
      try {
        connection.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
        if (row(connection, 'PRAGMA journal_mode')?.journal_mode !== 'delete') throw unavailable();
        connection.exec('BEGIN EXCLUSIVE');
        return connection;
      } catch {
        connection.close();
        throw unavailable();
      }
    };
    owner = acquire(ownerPath);
    same(ownerStat, inspect(ownerPath));
    if (exists(temporaryPath)) throw unavailable();
    if (initialize) {
      createFile(anchorOwnerPath);
      syncDirectory(options.anchorDirectory);
    }
    const anchorOwnerStat = inspect(anchorOwnerPath);
    anchorOwner = acquire(anchorOwnerPath);
    if (initialize) {
      // Reserve the final anchor name exclusively, also across distinct stores.
      // A crash leaves a malformed partial anchor, which always refuses reopen.
      createFile(anchorPath);
      syncDirectory(options.anchorDirectory);
      createFile(dataPath);
      syncDirectory(options.directory);
    }
    const anchorStat = inspect(anchorPath);
    const priorAnchor = initialize ? undefined : readAnchor(anchorPath);
    const dataStat = inspect(dataPath);
    // Check SQLite-created companions before letting SQLite follow/open them.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (exists(dataPath + suffix)) inspect(dataPath + suffix);
    }
    database = new DatabaseSync(dataPath);
    if (initialize) database.exec('PRAGMA journal_mode=WAL');
    database.exec(
      'PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON'
    );
    if (
      row(database, 'PRAGMA journal_mode')?.journal_mode !== 'wal' ||
      row(database, 'PRAGMA synchronous')?.synchronous !== 2 ||
      row(database, 'PRAGMA foreign_keys')?.foreign_keys !== 1
    )
      throw unavailable();
    const db = database as OwnedDatabase;
    const anchorLock = anchorOwner;
    const lock = owner;
    const checkPaths = () => {
      same(directoryStat, inspect(options.directory, true));
      same(anchorDirectoryStat, inspect(options.anchorDirectory, true));
      same(ownerStat, inspect(ownerPath));
      same(anchorOwnerStat, inspect(anchorOwnerPath));
      same(dataStat, inspect(dataPath));
    };
    let expectedAnchorStat = anchorStat;
    const writeAnchor = (value: JournalStoreWitness) => {
      checkPaths();
      same(expectedAnchorStat, inspect(anchorPath));
      const fd = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // No ACK is possible until the directory entry itself has been synced.
      renameSync(temporaryPath, anchorPath);
      syncDirectory(options.anchorDirectory);
      expectedAnchorStat = inspect(anchorPath);
    };
    let current: Readonly<JournalStoreWitness>;
    if (initialize) {
      current = witness({
        formatVersion: 1,
        storeUUID: randomUUID(),
        restoreGeneration: options.restoreGeneration,
        commitSeq: 0,
        commitNonce: randomUUID(),
      });
      db.exec('BEGIN IMMEDIATE');
      db.exec('PRAGMA user_version=1');
      db.exec(
        'CREATE TABLE journal_store (id INTEGER PRIMARY KEY CHECK(id=1), witness TEXT NOT NULL CHECK(length(witness)<=1024)) STRICT'
      );
      run(db, 'INSERT INTO journal_store VALUES (1, ?)', JSON.stringify(current));
      db.exec('COMMIT');
      syncDirectory(options.directory);
      writeAnchor(current);
    } else {
      if (
        row(db, 'PRAGMA user_version')?.user_version !== 1 ||
        row(db, 'SELECT count(*) AS count FROM journal_store')?.count !== 1
      )
        throw unavailable();
      const metadata = row(
        db,
        'SELECT id, typeof(witness) AS type, length(CAST(witness AS BLOB)) AS size FROM journal_store'
      );
      if (
        metadata?.id !== 1 ||
        metadata.type !== 'text' ||
        typeof metadata.size !== 'number' ||
        metadata.size < 1 ||
        metadata.size > 1024
      )
        throw unavailable();
      const stored = row(db, 'SELECT witness FROM journal_store WHERE id=1');
      if (typeof stored?.witness !== 'string') throw unavailable();
      current = witness(JSON.parse(stored.witness));
      if (stored.witness !== JSON.stringify(current)) throw unavailable();
      if (
        current.restoreGeneration !== options.restoreGeneration ||
        JSON.stringify(current) !== JSON.stringify(priorAnchor)
      )
        throw unavailable();
    }
    checkPaths();
    const assertOpen = () => {
      if (closed || sealed || mutating || !process.connected) throw unavailable();
      try {
        checkPaths();
      } catch {
        sealed = true;
        throw unavailable();
      }
    };
    const close = () => {
      if (closed) return;
      if (mutating) throw unavailable();
      sealed = true;
      // Never release the owner if the data connection failed to close.
      try {
        const checkpoint = row(db, 'PRAGMA wal_checkpoint(TRUNCATE)');
        if (checkpoint?.busy !== 0 || checkpoint.log !== 0 || checkpoint.checkpointed !== 0)
          throw unavailable();
        db.close();
        database = undefined;
        lock.exec('ROLLBACK');
        lock.close();
        anchorLock.exec('ROLLBACK');
        anchorLock.close();
        anchorOwner = undefined;
      } catch {
        throw unavailable();
      }
      owner = undefined;
      closed = true;
      liveDirectories.delete(options.directory);
      liveDirectories.delete(options.anchorDirectory);
      if (disconnect) process.off('disconnect', disconnect);
    };
    disconnect = () => {
      sealed = true;
      try {
        close();
      } finally {
        process.exit(1);
      }
    };
    process.once('disconnect', disconnect);
    return {
      get witness() {
        return current;
      },
      mutate<T>(change: (connection: JournalSqliteTransaction) => T): T {
        assertOpen();
        if (current.commitSeq === Number.MAX_SAFE_INTEGER) throw unavailable();
        mutating = true;
        try {
          db.exec('BEGIN IMMEDIATE');
          let active = true;
          db.setAuthorizer((action, arg1, arg2) =>
            forbidden.has(action) || arg1 === 'journal_store' || arg2 === 'journal_store'
              ? (codes.SQLITE_DENY as number)
              : (codes.SQLITE_OK as number)
          );
          const guard = () => {
            if (!active) throw unavailable();
          };
          const transaction: JournalSqliteTransaction = Object.freeze({
            exec(sql: string) {
              guard();
              db.exec(sql);
            },
            run(sql: string, ...parameters: SQLInputValue[]) {
              guard();
              run(db, sql, ...parameters);
            },
            get(sql: string, ...parameters: SQLInputValue[]) {
              guard();
              return row(db, sql, ...parameters);
            },
          });
          let result: T;
          try {
            const value = change(transaction);
            result = value === undefined ? value : (journalData(value) as T);
          } finally {
            active = false;
            db.setAuthorizer(null);
          }

          const next = witness({
            ...current,
            commitSeq: current.commitSeq + 1,
            commitNonce: randomUUID(),
          });
          run(db, 'UPDATE journal_store SET witness=? WHERE id=1', JSON.stringify(next));
          db.exec('COMMIT');
          syncDirectory(options.directory);
          writeAnchor(next);
          current = next;
          return result;
        } catch {
          sealed = true;
          try {
            db.exec('ROLLBACK');
          } catch {
            /* COMMIT may already have succeeded. */
          }
          throw unavailable();
        } finally {
          mutating = false;
        }
      },
      close,
    };
  } catch {
    sealed = true;
    if (disconnect) process.off('disconnect', disconnect);
    // Hold ownership if data close fails. The child must exit to release safely.
    try {
      database?.close();
      database = undefined;
      owner?.close();
      anchorOwner?.close();
      if (registered) {
        liveDirectories.delete(options.directory);
        liveDirectories.delete(options.anchorDirectory);
      }
    } catch {
      /* No optimistic unlock; process exit is the final owner boundary. */
    }
    throw unavailable();
  }
}
