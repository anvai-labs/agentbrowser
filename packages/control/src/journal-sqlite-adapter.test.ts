import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// J2b.2 step-2 qualification: the bounded manager and raw adapter factory over the
// production storage child. The storage-neutral conformance remains the semantics
// oracle (memory + direct fixtures, where the controlled clock can exercise expiry);
// these tests qualify what only the real manager/child stack can: one child for all
// handles, the manager-level second-handle refusal, child self-exit after the last
// handle closes, SIGKILL reacquisition with stale-fence clearing, and durable
// persistence across manager generations. Process-loss classification at crash
// barriers and the packaging gates are the next qualification slice (J2b.3+).
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openJournalSqliteOperationJournalAdapter } from './journal-sqlite-adapter.js';
import type { RawJournalNamespace } from './journal-types.js';
import { openOperationJournal } from './operation-journal.js';

const CHILD_MODULE = fileURLToPath(new URL('../dist/journal-sqlite-child.js', import.meta.url));

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function freshPaths(prefix: string): { directory: string; anchorDirectory: string } {
  const base = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  directories.push(base);
  const directory = join(base, 'store');
  const anchorDirectory = join(base, 'anchor');
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(anchorDirectory, { mode: 0o700 });
  return { directory, anchorDirectory };
}

const namespaceConfiguration = (namespaceId: string): RawJournalNamespace => ({
  schemaVersion: 1,
  namespaceId,
  fingerprintVersion: 1,
  fingerprintKeyId: 'key-1',
  restoreGeneration: 'generation-1',
  // Epoch-scale horizons: real wall clock never trips them. The port requires
  // retainUntil - acceptUntil >= maxFinalizationMs, so they cannot both be MAX.
  acceptUntil: Number.MAX_SAFE_INTEGER - 10_000,
  retainUntil: Number.MAX_SAFE_INTEGER,
  maxFinalizationMs: 1_000,
  bounds: {
    maxRecordBytes: 16_384,
    maxRecords: 4,
    maxNamespaces: 2,
    maxInFlight: 2,
    // Real IPC plus a durable fsync commit per call; the manager bounds its own maps.
    timeoutMs: 5_000,
  },
});

const intent = (operationId: string) => ({
  key: {
    serviceGeneration: 's'.repeat(22),
    tenantId: 'tenant-a',
    sessionIncarnation: 'i'.repeat(22),
    epoch: 1,
    operationId,
  },
  actor: 'operator-a',
  application: {
    adapterId: 'adapter-a',
    resourceId: 'resource-a',
    bindingGeneration: 'binding-a',
  },
  liveFingerprint: { algorithm: 'rest-json-v1', digest: `private-${operationId}` },
});

describe('SQLite journal manager and adapter (J2b.2 step 2)', () => {
  it('runs the full operation lifecycle through one child and persists across manager generations', async () => {
    const paths = freshPaths('journal-mgr-life-');
    const first = await openJournalSqliteOperationJournalAdapter({
      ...paths,
      restoreGeneration: 'generation-1',
      initialize: true,
      childModulePath: CHILD_MODULE,
    });
    const opened = await openOperationJournal(
      first,
      namespaceConfiguration('lifecycle-a'),
      Buffer.alloc(32, 7)
    );
    expect(opened.kind).toBe('opened');
    if (opened.kind !== 'opened') throw new Error('journal did not open');
    const key = intent('op-lifecycle').key;
    const reserved = await opened.journal.reserveIntent({
      key,
      actor: 'operator-a',
      liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-lifecycle' },
    });
    expect(reserved).toMatchObject({ kind: 'acknowledged', disposition: 'applied' });
    if (reserved.kind !== 'acknowledged') throw new Error('intent was not reserved');
    await opened.journal.markDispatch({ identity: reserved.record.identity, expectedRevision: 1 });
    const committed = await opened.journal.commitTerminal({
      identity: reserved.record.identity,
      expectedRevision: 2,
      dispatched: true,
      terminal: { status: 'completed', evidenceRefIds: ['evidence-1'] },
    });
    expect(committed).toMatchObject({ kind: 'acknowledged', record: { revision: 3 } });
    await opened.journal.close();
    await first.dispose();

    const second = await openJournalSqliteOperationJournalAdapter({
      ...paths,
      restoreGeneration: 'generation-1',
      childModulePath: CHILD_MODULE,
    });
    const reopened = await openOperationJournal(
      second,
      namespaceConfiguration('lifecycle-a'),
      Buffer.alloc(32, 7)
    );
    expect(reopened).toMatchObject({ kind: 'opened' });
    if (reopened.kind !== 'opened') throw new Error('journal did not reopen');
    const lookup = await reopened.journal.lookup(key);
    expect(lookup).toMatchObject({ kind: 'found', record: { revision: 3 } });
    await reopened.journal.close();
    await second.dispose();
  });

  it('refuses a second handle for a live namespace at the manager', async () => {
    const paths = freshPaths('journal-mgr-second-');
    const adapter = await openJournalSqliteOperationJournalAdapter({
      ...paths,
      restoreGeneration: 'generation-1',
      initialize: true,
      childModulePath: CHILD_MODULE,
    });
    const first = await openOperationJournal(
      adapter,
      namespaceConfiguration('second-a'),
      Buffer.alloc(32, 7)
    );
    expect(first.kind).toBe('opened');
    const second = await openOperationJournal(
      adapter,
      namespaceConfiguration('second-a'),
      Buffer.alloc(32, 7)
    );
    expect(second).toEqual({ kind: 'definitely_not_opened', reason: 'ownership' });
    // A different namespace in the same child opens fine: one child, many handles.
    const other = await openOperationJournal(
      adapter,
      namespaceConfiguration('second-b'),
      Buffer.alloc(32, 7)
    );
    expect(other.kind).toBe('opened');
    if (first.kind !== 'opened') throw new Error();
    await first.journal.close();
    if (other.kind !== 'opened') throw new Error();
    await other.journal.close();
    await adapter.dispose();
  });

  it('reacquires a SIGKILLed manager generation, clearing the dead owner fence', async () => {
    const paths = freshPaths('journal-mgr-kill-');
    const first = await openJournalSqliteOperationJournalAdapter({
      ...paths,
      restoreGeneration: 'generation-1',
      initialize: true,
      childModulePath: CHILD_MODULE,
    });
    const opened = await openOperationJournal(
      first,
      namespaceConfiguration('kill-a'),
      Buffer.alloc(32, 7)
    );
    expect(opened.kind).toBe('opened');
    if (opened.kind !== 'opened') throw new Error('journal did not open');
    const key = intent('op-kill').key;
    const reserved = await opened.journal.reserveIntent({
      key,
      actor: 'operator-a',
      liveFingerprint: { algorithm: 'rest-json-v1', digest: 'private-kill' },
    });
    expect(reserved).toMatchObject({ kind: 'acknowledged' });
    if (reserved.kind !== 'acknowledged') throw new Error();
    // SIGKILL with the fence still held: dispose is the crash simulation.
    await first.dispose();

    const second = await openJournalSqliteOperationJournalAdapter({
      ...paths,
      restoreGeneration: 'generation-1',
      childModulePath: CHILD_MODULE,
    });
    const reacquired = await openOperationJournal(
      second,
      namespaceConfiguration('kill-a'),
      Buffer.alloc(32, 7)
    );
    // The dead predecessor's fence is cleared at acquisition; the fresh owner
    // reclaims the namespace and the durable record is intact.
    expect(reacquired).toMatchObject({ kind: 'opened' });
    if (reacquired.kind !== 'opened') throw new Error('journal did not reacquire');
    const lookup = await reacquired.journal.lookup(key);
    expect(lookup).toMatchObject({ kind: 'found', record: { revision: 1 } });
    await reacquired.journal.close();
    await second.dispose();
  });

  it('lets the child exit after the last handle closes and treats the dead adapter as uncertain', async () => {
    const paths = freshPaths('journal-mgr-exit-');
    const adapter = await openJournalSqliteOperationJournalAdapter({
      ...paths,
      restoreGeneration: 'generation-1',
      initialize: true,
      childModulePath: CHILD_MODULE,
    });
    const opened = await openOperationJournal(
      adapter,
      namespaceConfiguration('exit-a'),
      Buffer.alloc(32, 7)
    );
    expect(opened.kind).toBe('opened');
    if (opened.kind !== 'opened') throw new Error('journal did not open');
    await opened.journal.close();
    await adapter.dispose();
    // The manager generation is gone; a further open is uncertain, never a silent
    // fresh store, until the caller explicitly builds a new manager.
    const after = await openOperationJournal(
      adapter,
      namespaceConfiguration('exit-a'),
      Buffer.alloc(32, 7)
    );
    expect(after).toMatchObject({ kind: 'uncertain' });
  });
});
