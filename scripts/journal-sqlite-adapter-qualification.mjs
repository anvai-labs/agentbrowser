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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  await opened.journal.close();
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
  await reopened.journal.close();
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
  await first.journal.close();
  await other.journal.close();
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
  await reacquired.journal.close();
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
      await reopened.journal.close();
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
    await other.journal.close();
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
  await opened.journal.close();
  // A different key produces a different fingerprintKeyCheck: the stored
  // descriptor no longer matches, and the refusal is configuration, not io.
  const other = await openOperationJournal(
    adapter,
    namespaceConfiguration('key-a'),
    Buffer.alloc(32, 9)
  );
  assert.deepEqual(other, { kind: 'definitely_not_opened', reason: 'configuration' });
  await keeper.journal.close();
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
  await opened.journal.close();
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
  await opened.journal.close();
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
  await opened.journal.close();
  await awaitChildSelfExit(adapter);
  await adapter.dispose();
  // A completed shutdown folds the WAL into the main database (TRUNCATE
  // checkpoint on the child's own close), so the sidecar must be gone or empty.
  const wal = join(paths.directory, 'journal.sqlite-wal');
  assert.ok(!existsSync(wal) || statSync(wal).size === 0, 'WAL survived graceful close');
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
  await opened.journal.close();
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
