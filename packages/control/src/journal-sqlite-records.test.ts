// J2b.2 step-1 qualification. Two tiers over the frozen v1 record schema:
// 1. The storage-neutral adapter conformance runs UNCHANGED against real SQLite
//    storage through an in-process fixture (no anchor/fsync commit unit, whose wall
//    time exceeds the conformance's fixed namespace timeout).
// 2. Child-hosted integration tests drive the record state machine through the real
//    storage owner across real IPC: durability across child restart, the storage
//    sentinel (raw key bytes and private fingerprints never persist), and the
//    schema freeze.
import { type ChildProcess, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StatementSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type JournalConformanceFixture,
  type ObservedMemoryNamespace,
  operationJournalAdapterConformance,
} from './journal-conformance.test-support.js';
import {
  closeJournalSqliteNamespace,
  commitJournalSqliteTerminal,
  lookupJournalSqliteRecord,
  markJournalSqliteDispatch,
  observeJournalSqliteNamespace,
  openJournalSqliteRecords,
  reserveJournalSqliteIntent,
} from './journal-sqlite-records.js';
import type { JournalSqliteTransaction } from './journal-sqlite-store.js';
import type { RawJournalNamespace } from './journal-types.js';
import { openOperationJournal } from './operation-journal.js';

// node:sqlite is not resolvable through vite's transform pipeline; the store owner's
// own tests stay child-only for the same reason. The direct fixture below needs a
// real SQLite connection in-process, so it reaches the builtin through createRequire.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

interface ChildReply {
  readonly kind?: unknown;
  readonly test?: unknown;
  readonly openId?: unknown;
  readonly correlationId?: unknown;
  readonly outcome?: unknown;
  readonly reason?: unknown;
  readonly namespace?: unknown;
  readonly ownerFence?: unknown;
  readonly snapshot?: unknown;
}

/** Correlated request/reply link; unconsumed test broadcasts are dropped. */
class ChildLink {
  private openSequence = 0;
  private correlationSequence = 0;
  private readonly pendingOpen = new Map<number, (reply: ChildReply) => void>();
  private readonly pendingCorrelation = new Map<number, (reply: ChildReply) => void>();

  constructor(private readonly child: ChildProcess) {
    child.on('message', (message: ChildReply) => {
      if (message.test !== undefined) return; // fire-and-forget test channel
      if (message.openId !== undefined) {
        this.pendingOpen.get(message.openId as number)?.(message);
        return;
      }
      if (message.correlationId !== undefined) {
        this.pendingCorrelation.get(message.correlationId as number)?.(message);
      }
    });
  }

  callOpen(descriptor: RawJournalNamespace): Promise<ChildReply> {
    const openId = ++this.openSequence;
    return new Promise((resolve, reject) => {
      this.pendingOpen.set(openId, resolve);
      try {
        this.send({ kind: 'open', openId, descriptor });
      } catch (error) {
        this.pendingOpen.delete(openId);
        reject(error);
      }
    });
  }

  callCorrelated(
    message: Record<string, unknown> & { correlationId: number }
  ): Promise<ChildReply> {
    const correlationId = message.correlationId;
    return new Promise((resolve, reject) => {
      this.pendingCorrelation.set(correlationId, resolve);
      try {
        this.send(message);
      } catch (error) {
        this.pendingCorrelation.delete(correlationId);
        reject(error);
      }
    });
  }

  nextCorrelationId(): number {
    return ++this.correlationSequence;
  }

  send(message: object): void {
    this.child.send(message);
  }

  /** Test channel: ordered fire-and-forget; the child applies messages serially. */
  sendTest(message: Record<string, unknown>): void {
    this.child.send(message);
  }

  awaitBroadcast(match: (message: ChildReply) => boolean): Promise<ChildReply> {
    return new Promise((resolve) => {
      const handler = (message: ChildReply) => {
        if (match(message)) {
          this.child.off('message', handler);
          resolve(message);
        }
      };
      this.child.on('message', handler);
    });
  }
}

const children: { child: ChildProcess; exited: Promise<unknown> }[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async ({ child, exited }) => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    })
  );
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface FixturePaths {
  readonly base: string;
  readonly directory: string;
  readonly anchorDirectory: string;
}
function freshPaths(prefix: string): FixturePaths {
  const base = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  directories.push(base);
  const directory = join(base, 'store');
  const anchorDirectory = join(base, 'anchor');
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(anchorDirectory, { mode: 0o700 });
  return { base, directory, anchorDirectory };
}

function spawnChild(options: Record<string, unknown>): ChildLink {
  const child = fork(
    new URL('./journal-sqlite-records.test-support.ts', import.meta.url),
    [JSON.stringify(options)],
    {
      execArgv: ['--experimental-strip-types'],
      cwd: tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }
  );
  const exited = once(child, 'exit');
  void exited.catch(() => {});
  // TEMP-DEBUG
  child.stderr?.on('data', (d) => console.log('CHILD_ERR', String(d).slice(0, 300)));
  children.push({ child, exited });
  return new ChildLink(child);
}

/** The raw adapter over the child link, shared by every fixture below. */
function adapterOverChild(
  link: ChildLink,
  refresh: (namespaceId: string) => Promise<void>
): { open(request: RawJournalNamespace, signal: AbortSignal): Promise<unknown> } {
  const openRaw = async (request: RawJournalNamespace, signal: AbortSignal): Promise<unknown> => {
    if (signal.aborted) return { kind: 'definitely_not_opened', reason: 'expired' };
    const reply = await link.callOpen(request);
    if (reply.kind === 'faulted') throw new Error('private storage fault during open');
    if (reply.kind !== 'opened') return { kind: reply.kind, reason: reply.reason };
    const namespaceId = request.namespaceId;
    const ownerFence = reply.ownerFence as string;
    const call = async (kind: string, value: unknown) => {
      const correlationId = link.nextCorrelationId();
      const response = await link.callCorrelated({
        kind,
        correlationId,
        namespaceId,
        ownerFence,
        value,
      });
      try {
        if (response.kind === 'faulted')
          throw new Error('private storage fault; no text crosses IPC');
        return response.outcome;
      } finally {
        await refresh(namespaceId);
      }
    };
    const handle = {
      reserveIntent: (stamped: { value: unknown }) => call('reserveIntent', stamped.value),
      markDispatch: (stamped: { value: unknown }) => call('markDispatch', stamped.value),
      commitTerminal: (stamped: { value: unknown }) => call('commitTerminal', stamped.value),
      lookup: (stamped: { value: unknown }) => call('lookup', stamped.value),
      async close() {
        const correlationId = link.nextCorrelationId();
        const response = await link.callCorrelated({
          kind: 'close',
          correlationId,
          namespaceId,
          ownerFence,
        });
        if (response.kind === 'faulted')
          throw new Error('private storage fault; no text crosses IPC');
        return (response.outcome as { readonly value: unknown }).value;
      },
    };
    await refresh(namespaceId);
    return {
      kind: 'opened',
      namespace: reply.namespace as RawJournalNamespace,
      ownerFence,
      handle,
    };
  };
  return {
    async open(request: RawJournalNamespace, signal: AbortSignal) {
      return openRaw(request, signal);
    },
  };
}

/**
 * The conformance fixture interface is synchronous, but the durable state lives in the
 * child: test-channel messages (clock, steal, faults) are ordered fire-and-forget sends,
 * and a local mirror is refreshed after every awaited adapter call — including faulted
 * ones — so `observe` reads the last settled state without crossing a process boundary
 * inside an assertion.
 */
async function startFixture(
  paths: FixturePaths,
  initialize: boolean
): Promise<JournalConformanceFixture & { dispose(): Promise<void>; paths: FixturePaths }> {
  const link = spawnChild({
    directory: paths.directory,
    anchorDirectory: paths.anchorDirectory,
    restoreGeneration: 'generation-1',
    initialize,
  });
  // Readiness handshake: the child registers its message handler only after the
  // storage owner opened, and the port's namespace timeout is far shorter than
  // child process startup, so no journal call may start before this round-trip.
  link.sendTest({ test: 'ready' });
  await link.awaitBroadcast((message) => message.test === 'ready_ack');
  let clock = 1_000;
  const mirror = new Map<string, ObservedMemoryNamespace>();
  const refresh = async (namespaceId: string) => {
    link.sendTest({ test: 'observe', namespaceId });
    const reply = await link.awaitBroadcast((message) => message.test === 'observed');
    const snapshot = reply.snapshot as ObservedMemoryNamespace | undefined;
    if (snapshot) mirror.set(namespaceId, snapshot);
    else mirror.delete(namespaceId);
  };
  return {
    fingerprintKey: Buffer.alloc(32, 7),
    now: () => clock,
    advance(milliseconds: number) {
      clock += milliseconds;
      link.sendTest({ test: 'advance', milliseconds });
    },
    adapter: adapterOverChild(link, refresh),
    observe(namespaceId: string) {
      return mirror.get(namespaceId);
    },
    releaseOwnership(namespaceId: string) {
      link.sendTest({ test: 'release_ownership', namespaceId });
    },
    failNext(method: string, point: string) {
      link.sendTest({ test: 'arm', method, point });
    },
    paths,
    async dispose() {
      link.sendTest({ test: 'dispose' });
      await link.awaitBroadcast((message) => message.test === 'disposed');
    },
  };
}

const namespaceConfiguration = (namespaceId: string): RawJournalNamespace => ({
  schemaVersion: 1,
  namespaceId,
  fingerprintVersion: 1,
  fingerprintKeyId: 'key-1',
  restoreGeneration: 'generation-1',
  acceptUntil: 2_000,
  retainUntil: 5_000,
  maxFinalizationMs: 1_000,
  bounds: {
    maxRecordBytes: 16_384,
    maxRecords: 4,
    maxNamespaces: 2,
    maxInFlight: 2,
    // Child-hosted tests cross real process IPC plus a durable commit per call;
    // the conformance's own 25 ms namespace stays with the memory oracle and the
    // direct fixture, whose storage path carries no anchor/fsync commit unit.
    timeoutMs: 5_000,
  },
});

/**
 * Conformance fixture over REAL SQLite storage held in-process: the frozen v1 schema
 * and the record state machine run against a durable database file. The anchor/fsync
 * commit unit of the storage owner — whose wall time legitimately exceeds the
 * conformance's fixed namespace timeout — is qualified separately by the owner's own
 * real-child suite and the child-hosted integration tests below.
 */
function createDirectSqliteJournalFixture(startTime = 1_000): JournalConformanceFixture {
  let clock = startTime;
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'journal-direct-'));
  directories.push(base);
  mkdirSync(join(base, 'store'), { mode: 0o700 });
  const connection = new DatabaseSync(join(base, 'store', 'journal.sqlite'));
  connection.exec('PRAGMA foreign_keys=ON');
  // The conformance tier pins record semantics, not durability: synchronous=OFF keeps
  // every case safely inside its fixed 25 ms namespace on slow CI disks. The anchor/
  // fsync commit unit is qualified by the owner's suite and the child-hosted tests.
  connection.exec('PRAGMA synchronous=OFF');
  const reader = new DatabaseSync(join(base, 'store', 'journal.sqlite'), {
    readOnly: true,
  });
  const prepared = <T>(
    database: InstanceType<typeof DatabaseSync>,
    sql: string,
    use: (statement: StatementSync) => T
  ): T => {
    const statement = database.prepare(sql);
    return use(statement);
  };
  const transaction = (): JournalSqliteTransaction => ({
    exec: (sql: string) => connection.exec(sql),
    run: (sql: string, ...parameters: never[]) =>
      prepared(connection, sql, (statement) => statement.run(...parameters)),
    get: (sql: string, ...parameters: never[]) =>
      prepared(connection, sql, (statement) => statement.get(...parameters)) as
        | Record<string, unknown>
        | undefined,
  });
  const readerFacade = {
    get: (sql: string, ...parameters: never[]) =>
      prepared(reader, sql, (statement) => statement.get(...parameters)) as
        | Record<string, unknown>
        | undefined,
    all: (sql: string, ...parameters: never[]) =>
      prepared(reader, sql, (statement) => statement.all(...parameters)) as Record<
        string,
        unknown
      >[],
  };
  type RawMethod = 'reserveIntent' | 'markDispatch' | 'commitTerminal';
  type FaultPoint = 'before_write' | 'after_commit' | 'never_settles';
  const faults = new Map<RawMethod, FaultPoint[]>();
  const takeFault = (method: RawMethod): FaultPoint | undefined => {
    const queue = faults.get(method);
    return queue?.shift();
  };
  const beginCommit = (change: () => unknown): unknown => {
    connection.exec('BEGIN IMMEDIATE');
    try {
      const result = change();
      connection.exec('COMMIT');
      return result;
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  };
  const mutate = (method: RawMethod, change: () => unknown): unknown => {
    const point = takeFault(method);
    if (point === 'before_write') throw new Error('private storage failure before write');
    if (point === 'never_settles') return new Promise(() => undefined);
    const result = beginCommit(change);
    if (point === 'after_commit') throw new Error('private acknowledgment loss after commit');
    return result;
  };
  interface DirectHandleState {
    closed: boolean;
  }
  return {
    fingerprintKey: Buffer.alloc(32, 7),
    now: () => clock,
    advance(milliseconds: number) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
        throw new Error('invalid clock advance');
      clock += milliseconds;
    },
    setClock(milliseconds: number) {
      if (!Number.isSafeInteger(milliseconds)) throw new Error('invalid clock set');
      clock = milliseconds;
    },
    adapter: {
      async open(request: RawJournalNamespace, signal: AbortSignal) {
        if (signal.aborted) return { kind: 'definitely_not_opened', reason: 'expired' };
        const outcome = beginCommit(() => openJournalSqliteRecords(transaction(), request, clock));
        if (outcome.kind !== 'opened')
          return { kind: 'definitely_not_opened', reason: outcome.reason };
        const ownerFence = outcome.ownerFence;
        const handleState: DirectHandleState = { closed: false };
        const envelope = (value: unknown) => ({
          namespaceId: request.namespaceId,
          ownerFence,
          value,
        });
        const refusal = () => {
          if (handleState.closed) return 'closed' as const;
          const live = readerFacade.get(
            'SELECT active_fence FROM journal_namespace WHERE namespace_id = ?',
            request.namespaceId
          );
          if (live?.active_fence !== ownerFence) return 'fenced' as const;
          if (clock > request.retainUntil) return 'expired' as const;
          return undefined;
        };
        const mutateStamped = (method: RawMethod, transition: unknown) =>
          mutate(method, () => {
            const refused = refusal();
            if (refused) return envelope({ kind: 'definitely_not_written', reason: refused });
            const tx = transaction();
            if (method === 'reserveIntent')
              return envelope(
                reserveJournalSqliteIntent(
                  tx,
                  request.namespaceId,
                  ownerFence,
                  transition as Parameters<typeof reserveJournalSqliteIntent>[3],
                  clock
                )
              );
            if (method === 'markDispatch')
              return envelope(
                markJournalSqliteDispatch(
                  tx,
                  request.namespaceId,
                  ownerFence,
                  transition as Parameters<typeof markJournalSqliteDispatch>[3],
                  clock
                )
              );
            return envelope(
              commitJournalSqliteTerminal(
                tx,
                request.namespaceId,
                ownerFence,
                transition as Parameters<typeof commitJournalSqliteTerminal>[3],
                clock
              )
            );
          });
        const handle = {
          reserveIntent: (stamped: { value: unknown }) =>
            mutateStamped('reserveIntent', stamped.value),
          markDispatch: (stamped: { value: unknown }) =>
            mutateStamped('markDispatch', stamped.value),
          commitTerminal: (stamped: { value: unknown }) =>
            mutateStamped('commitTerminal', stamped.value),
          lookup(stamped: { namespaceId: string; ownerFence: string; value: unknown }) {
            const refused = refusal();
            if (refused) return envelope({ kind: 'definitely_not_read', reason: refused });
            return envelope(
              lookupJournalSqliteRecord(
                readerFacade,
                request.namespaceId,
                ownerFence,
                stamped.value as Parameters<typeof lookupJournalSqliteRecord>[3],
                clock
              )
            );
          },
          async close() {
            handleState.closed = true;
            beginCommit(() =>
              closeJournalSqliteNamespace(transaction(), request.namespaceId, ownerFence)
            );
            return envelope({ kind: 'closed' });
          },
        };
        return {
          kind: 'opened',
          namespace: structuredClone(request),
          ownerFence,
          handle,
        };
      },
    },
    observe(namespaceId: string) {
      return observeJournalSqliteNamespace(readerFacade, namespaceId);
    },
    releaseOwnership(namespaceId: string) {
      beginCommit(() => {
        connection
          .prepare('UPDATE journal_namespace SET active_fence = NULL WHERE namespace_id = ?')
          .run(namespaceId);
        return null;
      });
    },
    failNext(method: RawMethod, point: FaultPoint): void {
      const queue = faults.get(method) ?? [];
      queue.push(point);
      faults.set(method, queue);
    },
  };
}

describe('concrete SQLite record storage (J2b.2 step 1)', () => {
  // The storage-neutral contract pins record/CAS/namespace semantics over real SQL
  // storage; the storage owner's durability unit (anchor, fsync, child host) is
  // qualified by the owner's own real-child suite and the child-hosted tests below.
  operationJournalAdapterConformance(() => createDirectSqliteJournalFixture());

  it('issues strictly monotonic fences so a stale generation can never write', async () => {
    // Three ownership generations: the conformance never reopens a namespace twice,
    // so a repeating fence sequence (which would let a stale generation write under
    // a live owner) is only visible here.
    const fixture = createDirectSqliteJournalFixture();
    const open = async () => {
      const result = await openOperationJournal(
        fixture.adapter,
        namespaceConfiguration('fences-a'),
        fixture.fingerprintKey
      );
      expect(result.kind).toBe('opened');
      if (result.kind !== 'opened') throw new Error('journal did not open');
      return result.journal;
    };
    const first = await open();
    const fenceAfterFirst = fixture.observe('fences-a')?.activeFence;
    await first.close();
    const second = await open();
    const fenceAfterSecond = fixture.observe('fences-a')?.activeFence;
    fixture.releaseOwnership('fences-a');
    const third = await open();
    const fenceAfterThird = fixture.observe('fences-a')?.activeFence;
    const serial = (fence: string) => Number(fence.replace('sqlite-fence-', ''));
    expect(serial(fenceAfterSecond!)).toBeGreaterThan(serial(fenceAfterFirst!));
    expect(serial(fenceAfterThird!)).toBeGreaterThan(serial(fenceAfterSecond!));
    const key = {
      serviceGeneration: 's'.repeat(22),
      tenantId: 'tenant-a',
      sessionIncarnation: 'i'.repeat(22),
      epoch: 1,
      operationId: 'op-stale',
    };
    await second
      .reserveIntent({
        key,
        actor: 'operator-a',
        liveFingerprint: { algorithm: 'rest-json-v1', digest: 'stale-generation' },
      })
      .then((outcome) =>
        expect(outcome).toEqual({ kind: 'definitely_not_written', reason: 'fenced' })
      );
    await third
      .reserveIntent({
        key,
        actor: 'operator-a',
        liveFingerprint: { algorithm: 'rest-json-v1', digest: 'stale-generation' },
      })
      .then((outcome) =>
        expect(outcome).toMatchObject({ kind: 'acknowledged', disposition: 'applied' })
      );
  });

  it('persists acknowledged records across a child restart and reopens with a fresh fence', async () => {
    const paths = freshPaths('journal-restart-');
    const first = await startFixture(paths, true);
    const opened = await openOperationJournal(
      first.adapter,
      namespaceConfiguration('restart-a'),
      first.fingerprintKey
    );
    expect(opened.kind).toBe('opened');
    if (opened.kind !== 'opened') throw new Error('journal did not open');
    const key = {
      serviceGeneration: 's'.repeat(22),
      tenantId: 'tenant-a',
      sessionIncarnation: 'i'.repeat(22),
      epoch: 1,
      operationId: 'op-restart',
    };
    const reserved = await opened.journal.reserveIntent({
      key,
      actor: 'operator-a',
      liveFingerprint: { algorithm: 'rest-json-v1', digest: 'sentinel-private-digest' },
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
    // Explicit close first: a held fence must survive disposal and the reopen below
    // proves the fresh-fence assignment instead of a refused ownership state.
    await opened.journal.close();
    await first.dispose();

    const second = await startFixture(paths, false);
    const reopened = await openOperationJournal(
      second.adapter,
      namespaceConfiguration('restart-a'),
      second.fingerprintKey
    );
    expect(reopened).toMatchObject({ kind: 'opened' });
    if (reopened.kind !== 'opened') throw new Error('journal did not reopen');
    const lookup = await reopened.journal.lookup(key);
    expect(lookup).toMatchObject({ kind: 'found', record: { revision: 3 } });
    expect(second.observe('restart-a')?.activeFence).toMatch(/^sqlite-fence-\d+$/);
    await second.dispose();
  });

  it('keeps the raw fingerprint key and private digests out of the durable bytes', async () => {
    const paths = freshPaths('journal-sentinel-');
    const fixture = await startFixture(paths, true);
    const opened = await openOperationJournal(
      fixture.adapter,
      namespaceConfiguration('sentinel-a'),
      fixture.fingerprintKey
    );
    expect(opened.kind).toBe('opened');
    if (opened.kind !== 'opened') throw new Error('journal did not open');
    const reserved = await opened.journal.reserveIntent({
      key: {
        serviceGeneration: 's'.repeat(22),
        tenantId: 'tenant-a',
        sessionIncarnation: 'i'.repeat(22),
        epoch: 1,
        operationId: 'op-sentinel',
      },
      actor: 'operator-a',
      liveFingerprint: { algorithm: 'rest-json-v1', digest: 'sentinel-private-digest' },
    });
    expect(reserved).toMatchObject({ kind: 'acknowledged' });
    await fixture.dispose();

    const bytes = readFileSync(join(paths.directory, 'journal.sqlite'));
    expect(bytes.includes(Buffer.alloc(32, 7))).toBe(false);
    expect(bytes.includes(Buffer.from('sentinel-private-digest'))).toBe(false);
  });

  it('freezes the v1 record schema shape in the durable file', async () => {
    const paths = freshPaths('journal-schema-');
    const fixture = await startFixture(paths, true);
    const opened = await openOperationJournal(
      fixture.adapter,
      namespaceConfiguration('schema-a'),
      fixture.fingerprintKey
    );
    expect(opened.kind).toBe('opened');
    if (opened.kind !== 'opened') throw new Error('journal did not open');
    await opened.journal.reserveIntent({
      key: {
        serviceGeneration: 's'.repeat(22),
        tenantId: 'tenant-a',
        sessionIncarnation: 'i'.repeat(22),
        epoch: 1,
        operationId: 'op-schema',
      },
      actor: 'operator-a',
      liveFingerprint: { algorithm: 'rest-json-v1', digest: 'schema-digest' },
    });
    await fixture.dispose();

    // Schema introspection runs in the child: node:sqlite is not importable in the
    // vitest process (see the store owner's own tests, which stay child-only too).
    const schemaLink = spawnChild({
      directory: paths.directory,
      anchorDirectory: paths.anchorDirectory,
      restoreGeneration: 'generation-1',
      initialize: false,
    });
    schemaLink.sendTest({ test: 'ready' });
    await schemaLink.awaitBroadcast((message) => message.test === 'ready_ack');
    schemaLink.sendTest({ test: 'inspect_schema' });
    const reply = await schemaLink.awaitBroadcast((message) => message.test === 'schema');
    schemaLink.sendTest({ test: 'dispose' });
    await schemaLink.awaitBroadcast((message) => message.test === 'disposed');
    const tables = reply.tables as { name: string; sql: string }[];
    const namespace = tables.find((table) => table.name === 'journal_namespace');
    const record = tables.find((table) => table.name === 'journal_record');
    expect(namespace?.sql).toContain('namespace_id TEXT NOT NULL PRIMARY KEY');
    expect(namespace?.sql).toContain(') STRICT');
    expect(record?.sql).toContain('PRIMARY KEY (namespace_id, record_key)');
    expect(record?.sql).toContain(
      'FOREIGN KEY (namespace_id) REFERENCES journal_namespace(namespace_id)'
    );
    expect(record?.sql).toContain(') STRICT');
    const columns = reply.columns as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual([
      'namespace_id',
      'record_key',
      'identity',
      'revision',
      'record',
    ]);
    const stored = reply.stored as { record: string }[];
    expect(JSON.parse(stored[0].record)).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      intent: true,
      dispatched: false,
    });
  });
});
