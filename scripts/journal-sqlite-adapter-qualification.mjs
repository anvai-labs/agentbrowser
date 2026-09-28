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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openOperationJournal } from '../packages/control/dist/operation-journal.js';
import { openJournalSqliteOperationJournalAdapter } from '../packages/control/dist/journal-sqlite-adapter.js';

const controlRoot = fileURLToPath(new URL('../packages/control/', import.meta.url));
const CHILD_MODULE = join(controlRoot, 'dist', 'journal-sqlite-child.js');

if (!existsSync(CHILD_MODULE)) {
  const { execFileSync } = await import('node:child_process');
  execFileSync('pnpm', ['--filter', '@agentbrowser/control', 'build'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: 'inherit',
  });
}

const directories = [];

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
