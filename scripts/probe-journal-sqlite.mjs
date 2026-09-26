#!/usr/bin/env node
/** J2 feasibility only: synthetic rows in an owned temporary directory, no adapter. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(import.meta.url);
const timeoutMs = 10000;
const { DatabaseSync } = await import('node:sqlite');

// This child is a deliberately tiny SQLite mechanism probe, not a journal worker.
if (process.argv[2] === '--child') {
  const [directory, mode] = process.argv.slice(3);
  assert.ok(process.send, 'child requires parent IPC');
  let closing = false;
  process.once('disconnect', () => process.exit(closing ? 0 : 1));
  const send = (message, finish = false) =>
    process.send(message, (error) => {
      if (error) process.exit(1);
      if (finish) {
        closing = true;
        process.disconnect();
      }
    });
  const lock = new DatabaseSync(join(directory, 'owner.sqlite'));
  lock.exec('PRAGMA busy_timeout=0');
  let acquired = false;
  try {
    lock.exec('BEGIN EXCLUSIVE');
    acquired = true;
  } catch (error) {
    if ((error.errcode & 255) !== 5) throw error;
    lock.close();
    send({ phase: 'busy' }, true);
  }
  if (acquired) {
    const db = new DatabaseSync(join(directory, 'data.sqlite'));
    db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=0');
    if (mode === 'commit') {
      db.exec('BEGIN IMMEDIATE; INSERT INTO facts VALUES (1); COMMIT');
    } else if (mode === 'rollback') {
      db.exec('BEGIN IMMEDIATE; INSERT INTO facts VALUES (2)');
    } else assert.equal(mode, 'owner');
    send({
      phase: mode,
      synchronous: db.prepare('PRAGMA synchronous').get().synchronous,
      journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
      ownerJournalMode: lock.prepare('PRAGMA journal_mode').get().journal_mode,
      rows: db
        .prepare('SELECT revision FROM facts ORDER BY revision')
        .all()
        .map((r) => r.revision),
    });
    process.on('message', (message) => {
      if (message === 'stall') {
        send({ phase: 'blocked' });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        send({ phase: 'resumed' });
        return;
      }
      assert.equal(message, 'close');
      db.close();
      lock.exec('ROLLBACK');
      lock.close();
      send({ phase: 'closed' }, true);
    });
  }
} else {
  assert.equal(process.argv.length, 2, 'usage: node scripts/probe-journal-sqlite.mjs');
  assert.ok(['darwin', 'linux'].includes(process.platform), 'probe requires a POSIX server target');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agentbrowser-sqlite-probe-')));
  const children = new Set();
  const start = (mode) => {
    const child = fork(file, ['--child', directory, mode], {
      execPath: process.execPath,
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    children.add(child);
    const closed = once(child, 'exit');
    closed.catch(() => {}); // wait/cleanup observes it; do not leak early spawn errors.
    // Bind the listener immediately so early child exit cannot cause an unnoticed hang.
    const wait = () =>
      Promise.race([
        once(child, 'message', { signal: AbortSignal.timeout(timeoutMs) }).then(
          ([message]) => message
        ),
        closed.then(() => {
          throw new Error('child exited before phase');
        }),
      ]);
    const send = (message) =>
      new Promise((resolve, reject) => {
        child.send(message, (error) => (error ? reject(error) : resolve()));
      });
    return { child, closed, wait, send };
  };
  const terminate = async (owner) => {
    assert.ok(owner.child.kill('SIGKILL'));
    const [, signal] = await owner.closed;
    assert.equal(signal, 'SIGKILL');
    children.delete(owner.child);
  };
  const close = async (owner) => {
    const phase = owner.wait();
    await owner.send('close');
    assert.deepEqual(await phase, { phase: 'closed' });
    assert.deepEqual(await owner.closed, [0, null]);
    children.delete(owner.child);
  };
  const read = () => {
    const db = new DatabaseSync(join(directory, 'data.sqlite'), { readOnly: true });
    try {
      return db
        .prepare('SELECT revision FROM facts ORDER BY revision')
        .all()
        .map((r) => r.revision);
    } finally {
      db.close();
    }
  };
  const state = (phase, rows) => ({
    phase,
    synchronous: 2,
    journalMode: 'wal',
    ownerJournalMode: 'delete',
    rows,
  });
  const checks = [];
  let sqliteVersion;
  let compileOptionsSha256;
  try {
    const lock = new DatabaseSync(join(directory, 'owner.sqlite'));
    try {
      assert.equal(lock.prepare('PRAGMA journal_mode=DELETE').get().journal_mode, 'delete');
      lock.exec('CREATE TABLE owner_lock (id INTEGER PRIMARY KEY) STRICT');
    } finally {
      lock.close();
    }
    const db = new DatabaseSync(join(directory, 'data.sqlite'));
    try {
      sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
      compileOptionsSha256 = createHash('sha256')
        .update(
          JSON.stringify(
            db
              .prepare('PRAGMA compile_options')
              .all()
              .map((row) => row.compile_options)
              .sort()
          )
        )
        .digest('hex');
      assert.equal(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode, 'wal');
      db.exec('PRAGMA synchronous=FULL; CREATE TABLE facts (revision INTEGER PRIMARY KEY) STRICT');
    } finally {
      db.close();
    }

    const owner = start('commit');
    assert.deepEqual(await owner.wait(), state('commit', [1]));
    assert.deepEqual(read(), [1]);
    checks.push('separate_connection_observes_commit_while_owner_lock_held');
    const contender = start('owner');
    assert.deepEqual(await contender.wait(), { phase: 'busy' });
    assert.deepEqual(await contender.closed, [0, null]);
    children.delete(contender.child);
    checks.push('competing_process_refused');
    // Test controller observes COMMIT but deliberately supplies no application ACK.
    await terminate(owner);
    // The next owner acquires the lifetime lock before it performs first recovery.
    const recovered = start('owner');
    assert.deepEqual(await recovered.wait(), state('owner', [1]));
    await close(recovered);
    checks.push('committed_row_survives_sigkill_before_application_ack');
    const uncommitted = start('rollback');
    assert.deepEqual(await uncommitted.wait(), state('rollback', [1, 2]));
    assert.deepEqual(read(), [1]);
    await terminate(uncommitted);
    const replacement = start('owner');
    assert.deepEqual(await replacement.wait(), state('owner', [1]));
    checks.push('uncommitted_row_absent_after_sigkill');
    let heartbeats = 0;
    const heartbeat = setInterval(() => heartbeats++, 10);
    try {
      const blocked = replacement.wait();
      await replacement.send('stall');
      assert.deepEqual(await blocked, { phase: 'blocked' });
      heartbeats = 0;
      assert.deepEqual(await replacement.wait(), { phase: 'resumed' });
      assert.ok(heartbeats > 0, 'parent event loop stalled with child');
    } finally {
      clearInterval(heartbeat);
    }
    checks.push('parent_heartbeat_during_synthetic_child_block');
    await close(replacement);
    const abandoned = start('owner');
    assert.deepEqual(await abandoned.wait(), state('owner', [1]));
    abandoned.child.disconnect();
    assert.deepEqual(await abandoned.closed, [1, null]);
    children.delete(abandoned.child);
    checks.push('owner_exits_on_parent_ipc_disconnect');
    const reopened = start('owner');
    assert.deepEqual(await reopened.wait(), state('owner', [1]));
    await close(reopened);
    checks.push('ownership_reacquired_after_process_loss_and_clean_close');
    console.log(
      JSON.stringify({
        kind: 'sqlite-feasibility',
        result: 'PASS',
        node: process.version,
        bun: process.versions.bun ?? null,
        platform: process.platform,
        arch: process.arch,
        sqliteVersion,
        compileOptionsSha256,
        checks,
        qualifiesJournalAdapter: false,
      })
    );
  } finally {
    // Never remove files while a probe-owned process might still be using them.
    const cleanup = await Promise.allSettled(
      [...children].map(async (child) => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        const closed = once(child, 'exit', { signal: AbortSignal.timeout(timeoutMs) });
        child.kill('SIGKILL');
        await closed;
      })
    );
    assert.ok(
      cleanup.every((result) => result.status === 'fulfilled'),
      'child cleanup failed; owned temporary files retained rather than deleted under live I/O'
    );
    await rm(directory, { recursive: true, force: true });
  }
}
