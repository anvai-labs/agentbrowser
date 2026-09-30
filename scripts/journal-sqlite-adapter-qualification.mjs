// T5 J2b.2 step-2 qualification gates for the concrete journal manager/child/adapter
// stack, run OUTSIDE vitest on purpose: the child-hosted gates proved flaky under the
// vitest worker (the storage child lost its store directory mid-flight, environment
// deterministically per invocation), while the identical stack is stable under plain
// Node. The storage-neutral conformance (record semantics) stays in vitest over the
// in-process direct fixture; these gates qualify what only the real manager/child
// stack can: one child for all handles, the manager-level second-handle refusal,
// SIGKILL reacquisition with stale-fence clearing, child self-exit, and durable
// persistence across manager generations.
//
// Run: node --test scripts/journal-sqlite-adapter-qualification.mjs
// (requires packages/control/dist — the script builds it if missing, like CI's
// clean-checkout order).
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openOperationJournal } from '../packages/control/dist/operation-journal.js';
import { openJournalSqliteOperationJournalAdapter } from '../packages/control/dist/journal-sqlite-adapter.js';

const controlRoot = fileURLToPath(new URL('../packages/control/', import.meta.url));
const CHILD_MODULE = join(controlRoot, 'dist', 'journal-sqlite-child.js');
const CRASH_CHILD_MODULE = join(
  controlRoot,
  'src',
  'journal-sqlite-adapter-crash-child.test-support.mjs'
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync(CHILD_MODULE)) {
  const { execFileSync } = await import('node:child_process');
  execFileSync('pnpm', ['--filter', '@agentbrowser/control', 'build'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: 'inherit',
  });
}

const directories = [];

/** Open one namespace through the port and return the live journal. */
async function openManagerNamespace(adapter, namespaceId) {
  const opened = await openOperationJournal(
    adapter,
    namespaceConfiguration(namespaceId),
    Buffer.alloc(32, 7)
  );
  assertOpened(opened);
  return opened.journal;
}

/** Close a namespace opened through openManagerNamespace. */
async function closeManagerNamespace(adapter, namespaceId) {
  // The port memoizes journals per adapter generation; reopening the namespace
  // would refuse at the manager, so this helper is only used before dispose.
  void adapter;
  void namespaceId;
}

function freshPaths(prefix) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  directories.push(base);
  const directory = join(base, 'store');
  const anchorDirectory = join(base, 'anchor');
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(anchorDirectory, { mode: 0o700 });
  return { directory, anchorDirectory };
}

async function startAdapter(paths, initialize) {
  const adapter = await openJournalSqliteOperationJournalAdapter({
    directory: paths.directory,
    anchorDirectory: paths.anchorDirectory,
    restoreGeneration: 'generation-1',
    initialize,
    childModulePath: CHILD_MODULE,
  });
  // Track the underlying child for teardown through the manager's own module
  // surface: dispose() awaits the child exit, so registry cleanup observes it.
  return adapter;
}

/** Await the child's own shutdown after a graceful namespace close. The child
 * checkpoints (wal TRUNCATE) and exits only AFTER the close reply is sent, so
 * proceeding straight to dispose() races the SIGKILL against the shutdown — on
 * a loaded runner the WAL survives uncheckpointed and later gates read state
 * that a completed shutdown would have folded into the main database.
 */
async function awaitChildSelfExit(adapter) {
  await Promise.race([
    adapter.exited,
    sleep(5_000).then(() => {
      throw new Error('storage child never self-exited after graceful close');
    }),
  ]);
}

test.afterEach(async () => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const namespaceConfiguration = (namespaceId) => ({
  schemaVersion: 1,
  namespaceId,
  fingerprintVersion: 1,
  fingerprintKeyId: 'key-1',
  restoreGeneration: 'generation-1',
  acceptUntil: Number.MAX_SAFE_INTEGER - 10_000,
  retainUntil: Number.MAX_SAFE_INTEGER,
  maxFinalizationMs: 1_000,
  bounds: {
    maxRecordBytes: 16_384,
    maxRecords: 4,
    maxNamespaces: 2,
    maxInFlight: 2,
    // Real IPC plus a durable fsync commit per call.
    timeoutMs: 5_000,
  },
});

const intentKey = (operationId) => ({
  serviceGeneration: 's'.repeat(22),
  tenantId: 'tenant-a',
  sessionIncarnation: 'i'.repeat(22),
  epoch: 1,
  operationId,
});

test('full operation lifecycle through one child, durable across manager generations', async () => {
  const paths = freshPaths('journal-mgr-life-');
  const first = await startAdapter({ ...paths }, true);
  const opened = await openOperationJournal(
    first,
    namespaceConfiguration('lifecycle-a'),
    Buffer.alloc(32, 7)
  );
  assertOpened(opened);
  const key = intentKey('op-lifecycle');
  const reserved = await opened.journal.reserveIntent({
    key,
    actor: 'operator-a',
    liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-lifecycle' },
  });
  assertAcknowledged(reserved);
  await opened.journal.markDispatch({ identity: reserved.record.identity, expectedRevision: 1 });
  const committed = await opened.journal.commitTerminal({
    identity: reserved.record.identity,
    expectedRevision: 2,
    dispatched: true,
    terminal: { status: 'completed', evidenceRefIds: ['evidence-1'] },
  });
  assert.equal(committed.kind, 'acknowledged');
  assert.equal(committed.record.revision, 3);
  assert.deepEqual(await opened.journal.close(), { kind: 'closed' });
  await first.dispose();

  const second = await startAdapter({ ...paths }, false);
  const reopened = await openOperationJournal(
    second,
    namespaceConfiguration('lifecycle-a'),
    Buffer.alloc(32, 7)
  );
  assertOpened(reopened);
  const lookup = await reopened.journal.lookup(key);
  assert.equal(lookup.kind, 'found');
  if (lookup.kind !== 'found') throw new Error('record did not persist');
  assert.equal(lookup.record.revision, 3);
  assert.deepEqual(await reopened.journal.close(), { kind: 'closed' });
  await second.dispose();
});

test('refuses a second handle for a live namespace at the manager', async () => {
  const paths = freshPaths('journal-mgr-second-');
  const adapter = await startAdapter({ ...paths }, true);
  const first = await openOperationJournal(
    adapter,
    namespaceConfiguration('second-a'),
    Buffer.alloc(32, 7)
  );
  assertOpened(first);
  const second = await openOperationJournal(
    adapter,
    namespaceConfiguration('second-a'),
    Buffer.alloc(32, 7)
  );
  assert.deepEqual(second, { kind: 'definitely_not_opened', reason: 'ownership' });
  const other = await openOperationJournal(
    adapter,
    namespaceConfiguration('second-b'),
    Buffer.alloc(32, 7)
  );
  assertOpened(other);
  assert.deepEqual(await first.journal.close(), { kind: 'closed' });
  assert.deepEqual(await other.journal.close(), { kind: 'closed' });
  await adapter.dispose();
});

test('reacquires a SIGKILLed manager generation, clearing the dead owner fence', async () => {
  const paths = freshPaths('journal-mgr-kill-');
  const first = await startAdapter({ ...paths }, true);
  const opened = await openOperationJournal(
    first,
    namespaceConfiguration('kill-a'),
    Buffer.alloc(32, 7)
  );
  assertOpened(opened);
  const key = intentKey('op-kill');
  const reserved = await opened.journal.reserveIntent({
    key,
    actor: 'operator-a',
    liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-kill' },
  });
  assertAcknowledged(reserved);
  // SIGKILL with the fence still held: dispose is the crash simulation.
  await first.dispose();
  // The dead manager cannot know ownership: the same namespace reports uncertain
  // on the dead adapter (never a definite refusal), while a fresh generation
  // acquires it immediately.
  const deadSame = await openOperationJournal(
    first,
    namespaceConfiguration('kill-a'),
    Buffer.alloc(32, 7)
  );
  assert.deepEqual(deadSame, { kind: 'uncertain', reason: 'io' });

  const second = await startAdapter({ ...paths }, false);
  const reacquired = await openOperationJournal(
    second,
    namespaceConfiguration('kill-a'),
    Buffer.alloc(32, 7)
  );
  assertOpened(reacquired);
  const lookup = await reacquired.journal.lookup(key);
  assert.equal(lookup.kind, 'found');
  if (lookup.kind !== 'found') throw new Error('record did not persist');
  assert.equal(lookup.record.revision, 1);
  assert.deepEqual(await reacquired.journal.close(), { kind: 'closed' });
  await second.dispose();
});

// ---------------------------------------------------------------------------
// J2b.3 process-loss matrix: SIGKILL the storage child while a reserveIntent is
// unresolved at deterministic commit barriers (the instrumented crash child blocks
// forever at the armed point; the kill is the continuation). Reopen outcomes per
// the design's matrix row: before COMMIT nothing persists and the store reopens
// cleanly; after COMMIT but before the anchor rename the DB/anchor mismatch
// REFUSES reopen (no auto-repair, no advancing the anchor); after the anchor
// rename but before the reply the acknowledged-ready intent is historical fact on
// reopen. Caller timeout alone (never_settles) must not kill the child.
// The instrumented crash child scopes its barrier arm to the faulted method's own
// dispatch (an unscoped COMMIT patch fires on the child's own bootstrap commits and
// hangs generation 1 pre-ready — a test-support bug the adversarial review caught,
// not a product state). All three rows run un-skipped.
for (const [point, expect] of [
  ['before_commit', 'absent'],
  ['after_commit', 'mismatch'],
  ['after_anchor', 'ready'],
]) {
  test(`process loss: SIGKILL at ${point} during reserveIntent`, async () => {
    const paths = freshPaths(`journal-crash-${point}-`);
    const first = await openJournalSqliteOperationJournalAdapter({
      ...paths,
      restoreGeneration: 'generation-1',
      initialize: true,
      childModulePath: CRASH_CHILD_MODULE,
      childArgv: [JSON.stringify({ method: 'reserveIntent', point })],
    });
    try {
      const opened = await openOperationJournal(
        first,
        namespaceConfiguration('crash-a'),
        Buffer.alloc(32, 7)
      );
      assertOpened(opened);
      const key = intentKey('op-crash');
      const pending = opened.journal.reserveIntent({
        key,
        actor: 'operator-a',
        liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-crash' },
      });
      await sleep(1_000); // the child crosses the barrier and blocks forever there
      process.kill(first.childPid, 'SIGKILL');
      const settled = await pending;
      assert.deepEqual(settled, { kind: 'uncertain', reason: 'io' });

      if (expect === 'mismatch') {
        // DB/anchor mismatch refuses reopen — no auto-repair, no anchor advance.
        await assert.rejects(
          openJournalSqliteOperationJournalAdapter({
            ...paths,
            restoreGeneration: 'generation-1',
            childModulePath: CHILD_MODULE,
          })
        );
        return;
      }
      const second = await openJournalSqliteOperationJournalAdapter({
        ...paths,
        restoreGeneration: 'generation-1',
        childModulePath: CHILD_MODULE,
      });
      const reopened = await openOperationJournal(
        second,
        namespaceConfiguration('crash-a'),
        Buffer.alloc(32, 7)
      );
      assertOpened(reopened);
      const lookup = await reopened.journal.lookup(key);
      if (expect === 'absent') assert.equal(lookup.kind, 'scoped_absent');
      else {
        assert.equal(lookup.kind, 'found');
        if (lookup.kind !== 'found') throw new Error();
        assert.equal(lookup.record.revision, 1);
        assert.equal(lookup.record.dispatched, false);
      }
      assert.deepEqual(await reopened.journal.close(), { kind: 'closed' });
      await second.dispose();
    } finally {
      await first.dispose().catch(() => {});
    }
  });
}

test('caller timeout alone neither kills the child nor grants new ownership', async () => {
  const paths = freshPaths('journal-crash-timeout-');
  const first = await openJournalSqliteOperationJournalAdapter({
    ...paths,
    restoreGeneration: 'generation-1',
    initialize: true,
    childModulePath: CRASH_CHILD_MODULE,
    childArgv: [JSON.stringify({ method: 'reserveIntent', point: 'never_settles' })],
  });
  try {
    const opened = await openOperationJournal(
      first,
      { ...namespaceConfiguration('timeout-a'), bounds: { ...namespaceConfiguration('timeout-a').bounds, timeoutMs: 1_000 } },
      Buffer.alloc(32, 7)
    );
    assertOpened(opened);
    const timedOut = await opened.journal.reserveIntent({
      key: intentKey('op-timeout'),
      actor: 'operator-a',
      liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-timeout' },
    });
    assert.deepEqual(timedOut, { kind: 'uncertain', reason: 'wait_expired' });
    // The child survived the caller timeout and still serves other namespaces.
    assert.doesNotThrow(() => process.kill(first.childPid, 0));
    const other = await openOperationJournal(
      first,
      namespaceConfiguration('timeout-b'),
      Buffer.alloc(32, 7)
    );
    assertOpened(other);
    assert.deepEqual(await other.journal.close(), { kind: 'closed' });
  } finally {
    await first.dispose().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// J2b.3 adversarial / bounded-resource matrix (manager/child stack level; the
// state-machine level is conformance-covered, the storage-owner level is covered
// by the owner's own real-child suite).

test('a second manager process on the same store loses the acquisition race', async () => {
  const paths = freshPaths('journal-atv-double-');
  const winner = await openJournalSqliteOperationJournalAdapter({
    ...paths,
    restoreGeneration: 'generation-1',
    initialize: true,
    childModulePath: CHILD_MODULE,
  });
  await openManagerNamespace(winner, 'double-a');
  // A competing manager on the same directory: its child exits(1) on the owner
  // lock, and the factory rejects the handshake instead of hanging.
  await assert.rejects(
    openJournalSqliteOperationJournalAdapter({
      ...paths,
      restoreGeneration: 'generation-1',
      childModulePath: CHILD_MODULE,
    })
  );
  // The winner is unaffected by the contender's failed spawn.
  await closeManagerNamespace(winner, 'double-a');
  await winner.dispose();
});

test('concurrent first initialization resolves exactly one winner', async () => {
  const paths = freshPaths('journal-atv-race-');
  const results = await Promise.allSettled([
    openJournalSqliteOperationJournalAdapter({
      ...paths,
      restoreGeneration: 'generation-1',
      initialize: true,
      childModulePath: CHILD_MODULE,
    }),
    openJournalSqliteOperationJournalAdapter({
      ...paths,
      restoreGeneration: 'generation-1',
      initialize: true,
      childModulePath: CHILD_MODULE,
    }),
  ]);
  // Exactly one winner regardless of which fork wins the O_EXCL race.
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const adapter = fulfilled[0].value;
  await openManagerNamespace(adapter, 'race-a');
  await adapter.dispose();
});

test('a different fingerprint key refuses the namespace as configuration', async () => {
  const paths = freshPaths('journal-atv-key-');
  const adapter = await startAdapter({ ...paths }, true);
  const opened = await openOperationJournal(
    adapter,
    namespaceConfiguration('key-a'),
    Buffer.alloc(32, 7)
  );
  assertOpened(opened);
  // A second live handle keeps the child alive after key-a closes: without it
  // the child self-exits and a dead manager could only answer uncertain:io
  // (the Linux failure), and with key-a still held the manager's own
  // second-handle refusal would answer ownership before the child ever sees
  // the descriptor.
  const keeper = await openOperationJournal(
    adapter,
    namespaceConfiguration('key-b'),
    Buffer.alloc(32, 7)
  );
  assertOpened(keeper);
  assert.deepEqual(await opened.journal.close(), { kind: 'closed' });
  // A different key produces a different fingerprintKeyCheck: the stored
  // descriptor no longer matches, and the refusal is configuration, not io.
  const other = await openOperationJournal(
    adapter,
    namespaceConfiguration('key-a'),
    Buffer.alloc(32, 9)
  );
  assert.deepEqual(other, { kind: 'definitely_not_opened', reason: 'configuration' });
  assert.deepEqual(await keeper.journal.close(), { kind: 'closed' });
  await awaitChildSelfExit(adapter);
  await adapter.dispose();
});

test('a corrupted durable database refuses reopen without auto-repair', async () => {
  const paths = freshPaths('journal-atv-corrupt-');
  const first = await openJournalSqliteOperationJournalAdapter({
    ...paths,
    restoreGeneration: 'generation-1',
    initialize: true,
    childModulePath: CHILD_MODULE,
  });
  const opened = await openOperationJournal(
    first,
    namespaceConfiguration('corrupt-a'),
    Buffer.alloc(32, 7)
  );
  assertOpened(opened);
  const reserved = await opened.journal.reserveIntent({
    key: intentKey('op-corrupt'),
    actor: 'operator-a',
    liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-corrupt' },
  });
  assertAcknowledged(reserved);
  assert.deepEqual(await opened.journal.close(), { kind: 'closed' });
  await awaitChildSelfExit(first);
  await first.dispose();

  // Corrupt the durable store in place (operator-investigation scenario): the
  // reopen refuses and nothing repairs or deletes the evidence.
  const database = join(paths.directory, 'journal.sqlite');
  const bytes = readFileSync(database);
  bytes.write('CORRUPTED', 100, 'utf8');
  writeFileSync(database, bytes);

  await assert.rejects(
    openJournalSqliteOperationJournalAdapter({
      ...paths,
      restoreGeneration: 'generation-1',
      childModulePath: CHILD_MODULE,
    })
  );
  // The evidence is preserved for investigation: the corrupted bytes remain.
  assert.ok(readFileSync(database).includes('CORRUPTED'));
});

test('a truncated durable database refuses reopen without auto-repair', async () => {
  const paths = freshPaths('journal-atv-trunc-');
  const first = await openJournalSqliteOperationJournalAdapter({
    ...paths,
    restoreGeneration: 'generation-1',
    initialize: true,
    childModulePath: CHILD_MODULE,
  });
  const opened = await openOperationJournal(
    first,
    namespaceConfiguration('trunc-a'),
    Buffer.alloc(32, 7)
  );
  assertOpened(opened);
  assert.deepEqual(await opened.journal.close(), { kind: 'closed' });
  await awaitChildSelfExit(first);
  await first.dispose();

  writeFileSync(join(paths.directory, 'journal.sqlite'), Buffer.alloc(64));
  await assert.rejects(
    openJournalSqliteOperationJournalAdapter({
      ...paths,
      restoreGeneration: 'generation-1',
      childModulePath: CHILD_MODULE,
    })
  );
  // No auto-repair: the truncated file is left for operator investigation.
  assert.equal(statSync(join(paths.directory, 'journal.sqlite')).size, 64);
});

test('dispose with outstanding I/O drains the call as uncertain', async () => {
  const paths = freshPaths('journal-atv-io-');
  const crashFault = JSON.stringify({ method: 'reserveIntent', point: 'never_settles' });
  const first = await openJournalSqliteOperationJournalAdapter({
    ...paths,
    restoreGeneration: 'generation-1',
    initialize: true,
    childModulePath: CRASH_CHILD_MODULE,
    childArgv: [crashFault],
  });
  const opened = await openOperationJournal(
    first,
    { ...namespaceConfiguration('io-a'), bounds: { ...namespaceConfiguration('io-a').bounds, timeoutMs: 60_000 } },
    Buffer.alloc(32, 7)
  );
  assertOpened(opened);
  const pending = opened.journal.reserveIntent({
    key: intentKey('op-io'),
    actor: 'operator-a',
    liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-io' },
  });
  await sleep(300); // the child withheld the reply; the call is outstanding
  await first.dispose(); // SIGKILLs the child with the call outstanding
  const drained = await pending;
  assert.deepEqual(drained, { kind: 'uncertain', reason: 'io' });
});

test('sustained writes stay within bounded file sizes; the anchor never grows', async () => {
  const paths = freshPaths('journal-atv-bounds-');
  const adapter = await startAdapter({ ...paths }, true);
  const opened = await openOperationJournal(
    adapter,
    { ...namespaceConfiguration('bounds-a'), bounds: { ...namespaceConfiguration('bounds-a').bounds, maxRecords: 64 } },
    Buffer.alloc(32, 7)
  );
  assertOpened(opened);
  for (let index = 0; index < 64; index += 1) {
    const reserved = await opened.journal.reserveIntent({
      key: intentKey(`op-bounds-${index}`),
      actor: 'operator-a',
      liveFingerprint: { algorithm: 'rest-json-v1', digest: `private-bounds-${index}` },
    });
    assertAcknowledged(reserved);
  }
  const anchorSize = statSync(join(paths.anchorDirectory, 'commit.json')).size;
  assert.ok(anchorSize <= 1024, `anchor grew to ${anchorSize}`);
  const databaseSize = statSync(join(paths.directory, 'journal.sqlite')).size;
  assert.ok(databaseSize > 0 && databaseSize < 5 * 1024 * 1024, `database size ${databaseSize}`);
  assert.deepEqual(await opened.journal.close(), { kind: 'closed' });
  await awaitChildSelfExit(adapter);
  await adapter.dispose();
  // A completed shutdown folds the WAL into the main database (TRUNCATE
  // checkpoint on the child's own close), so the sidecar must be gone or empty.
  const wal = join(paths.directory, 'journal.sqlite-wal');
  assert.ok(!existsSync(wal) || statSync(wal).size === 0, 'WAL survived graceful close');
});

test('a stale DB-only copy refuses reopen against the current anchor', async () => {
  const paths = freshPaths('journal-atv-stale-db-');
  const first = await startAdapter({ ...paths }, true);
  const journal = await openManagerNamespace(first, 'stale-db-a');
  assertAcknowledged(
    await journal.reserveIntent({
      key: intentKey('op-stale-db-1'),
      actor: 'operator-a',
      liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-stale-db' },
    })
  );
  assert.deepEqual(await journal.close(), { kind: 'closed' });
  await awaitChildSelfExit(first);
  // Graceful close checkpointed everything into the DB: snapshot the stale pair.
  const dataPath = join(paths.directory, 'journal.sqlite');
  const anchorPath = join(paths.anchorDirectory, 'commit.json');
  const staleDb = join(dirname(paths.directory), 'stale-db.sqlite');
  copyFileSync(dataPath, staleDb);

  // Advance durable state past the snapshot.
  const second = await startAdapter({ ...paths }, false);
  const advanced = await openManagerNamespace(second, 'stale-db-a');
  assertAcknowledged(
    await advanced.reserveIntent({
      key: intentKey('op-stale-db-2'),
      actor: 'operator-a',
      liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-stale-db-2' },
    })
  );
  assert.deepEqual(await advanced.close(), { kind: 'closed' });
  await awaitChildSelfExit(second);

  // Restore ONLY the stale DB: the current anchor witness no longer matches.
  copyFileSync(staleDb, dataPath);
  await assert.rejects(startAdapter({ ...paths }, false));
  // Evidence preserved: no auto-repair rewrote the stale copy.
  assert.deepEqual(readFileSync(dataPath), readFileSync(staleDb));
});

test('a stale anchor-only copy refuses reopen against the current database', async () => {
  const paths = freshPaths('journal-atv-stale-anchor-');
  const first = await startAdapter({ ...paths }, true);
  const journal = await openManagerNamespace(first, 'stale-anchor-a');
  assertAcknowledged(
    await journal.reserveIntent({
      key: intentKey('op-stale-anchor-1'),
      actor: 'operator-a',
      liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-stale-anchor' },
    })
  );
  assert.deepEqual(await journal.close(), { kind: 'closed' });
  await awaitChildSelfExit(first);
  const anchorPath = join(paths.anchorDirectory, 'commit.json');
  const staleAnchor = join(dirname(paths.directory), 'stale-anchor.json');
  copyFileSync(anchorPath, staleAnchor);

  const second = await startAdapter({ ...paths }, false);
  const advanced = await openManagerNamespace(second, 'stale-anchor-a');
  assertAcknowledged(
    await advanced.reserveIntent({
      key: intentKey('op-stale-anchor-2'),
      actor: 'operator-a',
      liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-stale-anchor-2' },
    })
  );
  assert.deepEqual(await advanced.close(), { kind: 'closed' });
  await awaitChildSelfExit(second);

  // Restore ONLY the stale anchor: the current DB witness no longer matches.
  copyFileSync(staleAnchor, anchorPath);
  await assert.rejects(startAdapter({ ...paths }, false));
  assert.deepEqual(readFileSync(anchorPath), readFileSync(staleAnchor));
});

test('a malformed anchor refuses reopen and is preserved for investigation', async () => {
  const paths = freshPaths('journal-atv-bad-anchor-');
  const first = await startAdapter({ ...paths }, true);
  const journal = await openManagerNamespace(first, 'bad-anchor-a');
  assert.deepEqual(await journal.close(), { kind: 'closed' });
  await awaitChildSelfExit(first);
  const anchorPath = join(paths.anchorDirectory, 'commit.json');
  writeFileSync(anchorPath, 'this is not anchor json');
  await assert.rejects(startAdapter({ ...paths }, false));
  assert.equal(readFileSync(anchorPath, 'utf8'), 'this is not anchor json');
});

test('a missing anchor refuses reopen without auto-recreation', async () => {
  const paths = freshPaths('journal-atv-no-anchor-');
  const first = await startAdapter({ ...paths }, true);
  const journal = await openManagerNamespace(first, 'no-anchor-a');
  assert.deepEqual(await journal.close(), { kind: 'closed' });
  await awaitChildSelfExit(first);
  const anchorPath = join(paths.anchorDirectory, 'commit.json');
  const dataPath = join(paths.directory, 'journal.sqlite');
  rmSync(anchorPath);
  await assert.rejects(startAdapter({ ...paths }, false));
  assert.ok(!existsSync(anchorPath), 'reopen recreated the missing anchor');
  assert.ok(existsSync(dataPath), 'reopen deleted the durable database');
});

test('a partially replaced anchor (leftover commit.pending) refuses reopen', async () => {
  const paths = freshPaths('journal-atv-partial-anchor-');
  const first = await startAdapter({ ...paths }, true);
  const journal = await openManagerNamespace(first, 'partial-anchor-a');
  assert.deepEqual(await journal.close(), { kind: 'closed' });
  await awaitChildSelfExit(first);
  const pendingPath = join(paths.anchorDirectory, 'commit.pending');
  writeFileSync(pendingPath, '{"partial":true');
  await assert.rejects(startAdapter({ ...paths }, false));
  assert.equal(readFileSync(pendingPath, 'utf8'), '{"partial":true');
});

test('hardlinked or symlinked durable data refuses reopen', async () => {
  const paths = freshPaths('journal-atv-alias-');
  const first = await startAdapter({ ...paths }, true);
  const journal = await openManagerNamespace(first, 'alias-a');
  assert.deepEqual(await journal.close(), { kind: 'closed' });
  await awaitChildSelfExit(first);
  const dataPath = join(paths.directory, 'journal.sqlite');

  // A hardlink doubles the link count the owner checks on every open.
  const aliasPath = join(paths.directory, 'journal.sqlite.alias');
  linkSync(dataPath, aliasPath);
  try {
    await assert.rejects(startAdapter({ ...paths }, false));
  } finally {
    unlinkSync(aliasPath);
  }

  // A symlink in the durable name itself is not a regular single-link file.
  renameSync(dataPath, `${dataPath}.real`);
  symlinkSync(`${dataPath}.real`, dataPath);
  try {
    await assert.rejects(startAdapter({ ...paths }, false));
  } finally {
    unlinkSync(dataPath);
    renameSync(`${dataPath}.real`, dataPath);
  }
});

test('store directory permission drift refuses reopen', async () => {
  const paths = freshPaths('journal-atv-perm-');
  const first = await startAdapter({ ...paths }, true);
  const journal = await openManagerNamespace(first, 'perm-a');
  assert.deepEqual(await journal.close(), { kind: 'closed' });
  await awaitChildSelfExit(first);

  for (const mode of [0o750, 0o500]) {
    chmodSync(paths.directory, mode);
    try {
      await assert.rejects(startAdapter({ ...paths }, false), undefined, `mode ${mode.toString(8)} accepted`);
    } finally {
      chmodSync(paths.directory, 0o700);
    }
  }
});

test('an external writer lock BUSYs one mutation, seals the owner, and reopens clean', async () => {
  const paths = freshPaths('journal-atv-busy-');
  const adapter = await startAdapter({ ...paths }, true);
  const journal = await openManagerNamespace(adapter, 'busy-a');
  const external = new DatabaseSync(join(paths.directory, 'journal.sqlite'));
  external.exec('BEGIN EXCLUSIVE');
  // busy_timeout is zero inside the child: the write lock is BUSY immediately,
  // the mutation cannot be classified, and the owner seals.
  const outcome = await journal.reserveIntent({
    key: intentKey('op-busy'),
    actor: 'operator-a',
    liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-busy' },
  });
  assert.notEqual(outcome.kind, 'acknowledged');
  external.exec('ROLLBACK');
  external.close();
  // The sealed owner can neither confirm the namespace close nor accept work.
  const closed = await journal.close();
  assert.notEqual(closed.kind, 'closed');
  await adapter.dispose();

  // BUSY alone leaves a consistent pair: a fresh generation acquires cleanly
  // and the unclassified intent is not silently present.
  const second = await startAdapter({ ...paths }, false);
  const reopened = await openOperationJournal(
    second,
    namespaceConfiguration('busy-a'),
    Buffer.alloc(32, 7)
  );
  assertOpened(reopened);
  const retry = await reopened.journal.reserveIntent({
    key: intentKey('op-busy'),
    actor: 'operator-a',
    liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-busy' },
  });
  assertAcknowledged(retry);
  // 'applied', not 'existing': the BUSYed mutation wrote nothing.
  assert.equal(retry.disposition, 'applied');
  assert.deepEqual(await reopened.journal.close(), { kind: 'closed' });
  await second.dispose();
});

test('admission ceilings refuse capacity without evicting accepted identities', async () => {
  const paths = freshPaths('journal-atv-exhaust-');
  const adapter = await startAdapter({ ...paths }, true);
  const base = namespaceConfiguration('exhaust-a');
  const opened = await openOperationJournal(
    adapter,
    {
      ...base,
      bounds: { ...base.bounds, maxNamespaces: 1, maxRecords: 2, maxRecordBytes: 8192 },
    },
    Buffer.alloc(32, 7)
  );
  assertOpened(opened);
  const secondNamespace = await openOperationJournal(
    adapter,
    {
      ...namespaceConfiguration('exhaust-b'),
      bounds: { ...namespaceConfiguration('exhaust-b').bounds, maxNamespaces: 1 },
    },
    Buffer.alloc(32, 7)
  );
  // Later namespaces must repeat the first namespace's maxNamespaces (a
  // mismatch is configuration); with the bound repeated, the count refuses.
  assert.deepEqual(secondNamespace, { kind: 'definitely_not_opened', reason: 'capacity' });

  const key1 = intentKey('op-exhaust-1');
  const key2 = intentKey('op-exhaust-2');
  assertAcknowledged(await opened.journal.reserveIntent({ key: key1, actor: 'operator-a', liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-exhaust-1' } }));
  assertAcknowledged(await opened.journal.reserveIntent({ key: key2, actor: 'operator-a', liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-exhaust-2' } }));
  const third = await opened.journal.reserveIntent({
    key: intentKey('op-exhaust-3'),
    actor: 'operator-a',
    liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-exhaust-3' },
  });
  assert.deepEqual(third, { kind: 'definitely_not_written', reason: 'capacity' });
  // The record ceiling bounds transitions at the port: the oversize input is
  // refused before any write (the port's parse bound; the count ceilings above
  // carry the capacity reason). Nothing persists either way.
  const oversize = await opened.journal.reserveIntent({
    key: intentKey('op-exhaust-big'),
    actor: 'operator-a',
    liveFingerprint: { algorithm: 'rest-json-v1', digest: 'x'.repeat(16384) },
  });
  assert.equal(oversize.kind, 'definitely_not_written');
  assert.equal(
    (await opened.journal.lookup(intentKey('op-exhaust-big'))).kind,
    'scoped_absent'
  );

  // Accepted identities survive the refusals: no eviction to admit newcomers.
  assert.equal((await opened.journal.lookup(key1)).kind, 'found');
  assert.equal((await opened.journal.lookup(key2)).kind, 'found');
  assert.deepEqual(await opened.journal.close(), { kind: 'closed' });
  await adapter.dispose();
});

test('raw fingerprint key material never persists in storage or anchor', async () => {
  const paths = freshPaths('journal-atv-sentinel-');
  const adapter = await startAdapter({ ...paths }, true);
  const rawKey = Buffer.alloc(32, 0xab);
  const opened = await openOperationJournal(
    adapter,
    namespaceConfiguration('sentinel-a'),
    rawKey
  );
  assertOpened(opened);
  assertAcknowledged(
    await opened.journal.reserveIntent({
      key: intentKey('op-sentinel'),
      actor: 'operator-a',
      liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-sentinel' },
    })
  );
  assert.deepEqual(await opened.journal.close(), { kind: 'closed' });
  await awaitChildSelfExit(adapter);
  await adapter.dispose();

  // Positive control: the namespace really is durable on disk.
  assert.ok(
    readFileSync(join(paths.directory, 'journal.sqlite')).includes(Buffer.from('sentinel-a')),
    'positive control failed: namespace id absent from storage'
  );
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) scan(child);
      else
        assert.ok(
          !readFileSync(child).includes(rawKey),
          `${child} contains raw fingerprint key material`
        );
    }
  };
  scan(paths.directory);
  scan(paths.anchorDirectory);
});

test('CLI and MCP source trees carry no journal storage code', async () => {
  // The design invariant: CLI/MCP Bun builds must remain free of journal storage
  // code and dependencies. Static source scan; the dependency graph is checked
  // in CI (package.json diffs).
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  for (const surface of ['packages/cli/src', 'packages/mcp-server/src']) {
    const scan = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name);
        if (entry.isDirectory()) scan(child);
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs')) {
          const source = readFileSync(child, 'utf8');
          assert.ok(
            !source.includes('journal-sqlite'),
            `${child} references journal storage code`
          );
        }
      }
    };
    scan(join(repoRoot, surface));
  }
});

test('child exits after the last handle closes; a dead adapter reports uncertain', async () => {
  const paths = freshPaths('journal-mgr-exit-');
  const adapter = await startAdapter({ ...paths }, true);
  const opened = await openOperationJournal(
    adapter,
    namespaceConfiguration('exit-a'),
    Buffer.alloc(32, 7)
  );
  assertOpened(opened);
  assert.deepEqual(await opened.journal.close(), { kind: 'closed' });
  await adapter.dispose();
  const after = await openOperationJournal(
    adapter,
    namespaceConfiguration('exit-a'),
    Buffer.alloc(32, 7)
  );
  assert.deepEqual(after, { kind: 'uncertain', reason: 'io' });
});

function assertOpened(outcome) {
  assert.equal(outcome.kind, 'opened');
  if (outcome.kind !== 'opened') throw new Error('journal did not open');
}
function assertAcknowledged(outcome) {
  assert.equal(outcome.kind, 'acknowledged');
  if (outcome.kind !== 'acknowledged') throw new Error('mutation was not acknowledged');
}
// canary probe: exercises the journal gates job on CI for hang diagnosis
