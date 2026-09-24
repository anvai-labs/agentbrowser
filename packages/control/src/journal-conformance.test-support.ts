import { canonicalJson } from '@agentbrowser/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  JournalIdentity,
  JournalIntent,
  JournalKey,
  JournalNamespace,
  JournalRecord,
  JournalTerminalTransition,
  JournalTransition,
  RawJournalNamespace,
  RawOperationJournalAdapter,
  RawOperationJournalHandle,
  Stamped,
} from './journal-types.js';
import { openOperationJournal } from './operation-journal.js';

type RawMethod = 'reserveIntent' | 'markDispatch' | 'commitTerminal' | 'lookup';
type FailurePoint = 'before_write' | 'after_commit' | 'never_settles';

interface StoredNamespace {
  readonly descriptor: RawJournalNamespace;
  readonly records: Map<string, JournalRecord>;
  activeFence: string | undefined;
  nextFence: number;
  reservedBytes: number;
}

export interface ObservedMemoryNamespace {
  readonly descriptor: RawJournalNamespace;
  readonly activeFence?: string;
  readonly records: readonly JournalRecord[];
  readonly reservedBytes: number;
}

export interface JournalConformanceFixture {
  readonly adapter: RawOperationJournalAdapter;
  readonly fingerprintKey: Uint8Array;
  now(): number;
  advance(milliseconds: number): void;
  observe(namespaceId: string): ObservedMemoryNamespace | undefined;
  releaseOwnership(namespaceId: string): void;
  failNext(method: RawMethod, point: FailurePoint): void;
}

const copy = <T>(value: T): T => structuredClone(value);
const same = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);
const recordKey = (key: JournalKey): string => canonicalJson(key);
const stamped = <T>(namespaceId: string, ownerFence: string, value: T): Stamped<T> => ({
  namespaceId,
  ownerFence,
  value,
});

/**
 * Test-only atomic store. Observation and fault hooks are deliberately outside the
 * raw adapter port so tests never mistake them for production capabilities.
 */
export function createMemoryJournalFixture(startTime = 1_000): JournalConformanceFixture {
  let clock = startTime;
  let storeMaxNamespaces: number | undefined;
  const namespaces = new Map<string, StoredNamespace>();
  const failures = new Map<RawMethod, FailurePoint[]>();

  const takeFailure = (method: RawMethod): FailurePoint | undefined =>
    failures.get(method)?.shift();
  const run = async <T>(method: RawMethod, mutation: () => T): Promise<T> => {
    const point = takeFailure(method);
    if (point === 'before_write') throw new Error('private storage failure before write');
    if (point === 'never_settles') return new Promise<T>(() => undefined);
    const result = mutation();
    if (point === 'after_commit') throw new Error('private acknowledgment loss after commit');
    return result;
  };

  const adapter: RawOperationJournalAdapter = {
    async open(request, signal) {
      if (signal.aborted) return { kind: 'definitely_not_opened', reason: 'expired' };
      let state = namespaces.get(request.namespaceId);
      if (state) {
        if (!same(state.descriptor, request))
          return { kind: 'definitely_not_opened', reason: 'configuration' };
        if (clock > state.descriptor.retainUntil)
          return { kind: 'definitely_not_opened', reason: 'expired' };
        if (state.activeFence) return { kind: 'definitely_not_opened', reason: 'ownership' };
      } else {
        if (clock > request.acceptUntil || clock > request.retainUntil)
          return { kind: 'definitely_not_opened', reason: 'expired' };
        if (
          storeMaxNamespaces !== undefined &&
          request.bounds.maxNamespaces !== storeMaxNamespaces
        ) {
          return { kind: 'definitely_not_opened', reason: 'configuration' };
        }
        storeMaxNamespaces ??= request.bounds.maxNamespaces;
        if (namespaces.size >= storeMaxNamespaces)
          return { kind: 'definitely_not_opened', reason: 'capacity' };
        state = {
          descriptor: copy(request),
          records: new Map(),
          activeFence: undefined,
          nextFence: 1,
          reservedBytes: 0,
        };
        namespaces.set(request.namespaceId, state);
      }

      const ownerFence = `memory-fence-${state.nextFence++}`;
      state.activeFence = ownerFence;
      let closed = false;
      const mutationRefusal = (requestStamp: { namespaceId: string; ownerFence: string }) => {
        if (closed) return 'closed' as const;
        if (
          requestStamp.namespaceId !== state.descriptor.namespaceId ||
          requestStamp.ownerFence !== ownerFence ||
          state.activeFence !== ownerFence
        )
          return 'fenced' as const;
        if (clock > state.descriptor.retainUntil) return 'expired' as const;
        return undefined;
      };
      const mutationEnvelope = <T>(value: T) =>
        stamped(state.descriptor.namespaceId, ownerFence, value);
      const handle: RawOperationJournalHandle = {
        reserveIntent(requestStamp) {
          return run('reserveIntent', () => {
            const refused = mutationRefusal(requestStamp);
            if (refused)
              return mutationEnvelope({ kind: 'definitely_not_written', reason: refused });
            const transition = requestStamp.value;
            const key = recordKey(transition.identity.key);
            const current = state.records.get(key);
            if (current) {
              if (!same(current.identity, transition.identity))
                return mutationEnvelope({ kind: 'conflict', reason: 'identity' });
              return mutationEnvelope({
                kind: 'acknowledged',
                disposition: 'existing',
                record: copy(current),
              });
            }
            if (transition.expectedRevision !== 0)
              return mutationEnvelope({ kind: 'conflict', reason: 'revision' });
            if (clock > state.descriptor.acceptUntil)
              return mutationEnvelope({
                kind: 'definitely_not_written',
                reason: 'admission_expired',
              });
            if (state.records.size >= state.descriptor.bounds.maxRecords)
              return mutationEnvelope({ kind: 'definitely_not_written', reason: 'capacity' });
            const record: JournalRecord = {
              schemaVersion: 1,
              namespaceId: state.descriptor.namespaceId,
              identity: copy(transition.identity),
              revision: 1,
              intent: true,
              dispatched: false,
            };
            state.records.set(key, record);
            // Intent admission reserves the maximum configured terminal-record slot.
            state.reservedBytes += state.descriptor.bounds.maxRecordBytes;
            return mutationEnvelope({
              kind: 'acknowledged',
              disposition: 'applied',
              record: copy(record),
            });
          });
        },
        markDispatch(requestStamp) {
          return run('markDispatch', () => {
            const refused = mutationRefusal(requestStamp);
            if (refused)
              return mutationEnvelope({ kind: 'definitely_not_written', reason: refused });
            const transition = requestStamp.value;
            const key = recordKey(transition.identity.key);
            const current = state.records.get(key);
            if (!current) return mutationEnvelope({ kind: 'conflict', reason: 'missing_intent' });
            if (!same(current.identity, transition.identity))
              return mutationEnvelope({ kind: 'conflict', reason: 'identity' });
            if (current.terminal)
              return mutationEnvelope({ kind: 'conflict', reason: 'operation_terminal' });
            if (current.revision === 2 && current.dispatched && transition.expectedRevision === 1) {
              return mutationEnvelope({
                kind: 'acknowledged',
                disposition: 'already_applied',
                record: copy(current),
              });
            }
            if (current.revision !== 1 || current.dispatched || transition.expectedRevision !== 1) {
              return mutationEnvelope({ kind: 'conflict', reason: 'revision' });
            }
            const record: JournalRecord = { ...copy(current), revision: 2, dispatched: true };
            state.records.set(key, record);
            return mutationEnvelope({
              kind: 'acknowledged',
              disposition: 'applied',
              record: copy(record),
            });
          });
        },
        commitTerminal(requestStamp) {
          return run('commitTerminal', () => {
            const refused = mutationRefusal(requestStamp);
            if (refused)
              return mutationEnvelope({ kind: 'definitely_not_written', reason: refused });
            const transition = requestStamp.value;
            const key = recordKey(transition.identity.key);
            const current = state.records.get(key);
            if (!current) return mutationEnvelope({ kind: 'conflict', reason: 'missing_intent' });
            if (!same(current.identity, transition.identity))
              return mutationEnvelope({ kind: 'conflict', reason: 'identity' });
            if (current.terminal) {
              const predecessorRevision = current.dispatched ? 2 : 1;
              if (transition.expectedRevision !== predecessorRevision)
                return mutationEnvelope({ kind: 'conflict', reason: 'revision' });
              if (
                current.dispatched !== transition.dispatched ||
                !same(current.terminal, transition.terminal)
              ) {
                return mutationEnvelope({ kind: 'conflict', reason: 'terminal_facts' });
              }
              return mutationEnvelope({
                kind: 'acknowledged',
                disposition: 'already_applied',
                record: copy(current),
              });
            }
            const legalPredispatch =
              !transition.dispatched &&
              transition.expectedRevision === 1 &&
              current.revision === 1 &&
              !current.dispatched &&
              transition.terminal.status === 'failed';
            const legalDispatched =
              transition.dispatched &&
              transition.expectedRevision === 2 &&
              current.revision === 2 &&
              current.dispatched;
            if (!legalPredispatch && !legalDispatched)
              return mutationEnvelope({ kind: 'conflict', reason: 'revision' });
            const record: JournalRecord = {
              ...copy(current),
              revision: transition.dispatched ? 3 : 2,
              dispatched: transition.dispatched,
              terminal: copy(transition.terminal),
            };
            state.records.set(key, record);
            return mutationEnvelope({
              kind: 'acknowledged',
              disposition: 'applied',
              record: copy(record),
            });
          });
        },
        lookup(requestStamp) {
          return run('lookup', () => {
            const refused = mutationRefusal(requestStamp);
            if (refused) return mutationEnvelope({ kind: 'definitely_not_read', reason: refused });
            const current = state.records.get(recordKey(requestStamp.value));
            return current
              ? mutationEnvelope({ kind: 'found', record: copy(current) })
              : mutationEnvelope({ kind: 'scoped_absent' });
          });
        },
        async close() {
          if (!closed) {
            closed = true;
            if (state.activeFence === ownerFence) state.activeFence = undefined;
          }
          return { kind: 'closed' };
        },
      };
      return { kind: 'opened', namespace: copy(state.descriptor), ownerFence, handle };
    },
  };

  return {
    adapter,
    fingerprintKey: Buffer.alloc(32, 7),
    now: () => clock,
    advance(milliseconds) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
        throw new Error('invalid clock advance');
      clock += milliseconds;
    },
    observe(namespaceId) {
      const state = namespaces.get(namespaceId);
      if (!state) return undefined;
      return copy({
        descriptor: state.descriptor,
        ...(state.activeFence ? { activeFence: state.activeFence } : {}),
        records: [...state.records.values()],
        reservedBytes: state.reservedBytes,
      });
    },
    releaseOwnership(namespaceId) {
      const state = namespaces.get(namespaceId);
      if (state) state.activeFence = undefined;
    },
    failNext(method, point) {
      const queue = failures.get(method) ?? [];
      queue.push(point);
      failures.set(method, queue);
    },
  };
}

const namespace = (overrides: Partial<JournalNamespace> = {}): JournalNamespace => ({
  schemaVersion: 1,
  namespaceId: 'deployment-a',
  fingerprintVersion: 1,
  fingerprintKeyId: 'key-1',
  restoreGeneration: 'operator-generation-1',
  acceptUntil: 2_000,
  retainUntil: 5_000,
  maxFinalizationMs: 1_000,
  bounds: {
    maxRecordBytes: 16_384,
    maxRecords: 4,
    maxNamespaces: 2,
    maxInFlight: 2,
    timeoutMs: 25,
  },
  ...overrides,
});
const intent = (operationId = 'op-1', actor = 'operator-a'): JournalIntent => ({
  key: {
    serviceGeneration: 's'.repeat(22),
    tenantId: 'tenant-a',
    sessionIncarnation: 'i'.repeat(22),
    epoch: 1,
    operationId,
  },
  actor,
  liveFingerprint: { algorithm: 'rest-json-v1', digest: `private-${operationId}` },
});
async function open(fixture: JournalConformanceFixture, configuration = namespace()) {
  const result = await openOperationJournal(fixture.adapter, configuration, fixture.fingerprintKey);
  expect(result.kind).toBe('opened');
  if (result.kind !== 'opened') throw new Error('journal did not open');
  return result.journal;
}
async function reserve(fixture: JournalConformanceFixture, operationId = 'op-1') {
  const journal = await open(fixture);
  const result = await journal.reserveIntent(intent(operationId));
  expect(result.kind).toBe('acknowledged');
  if (result.kind !== 'acknowledged') throw new Error('intent was not reserved');
  return { journal, record: result.record };
}

/** Register the storage-neutral adapter contract against any independently observable fixture. */
export function operationJournalAdapterConformance(
  factory: () => JournalConformanceFixture = createMemoryJournalFixture
): void {
  afterEach(() => vi.useRealTimers());

  describe('operation journal raw adapter conformance', () => {
    it('reserves once, returns the current record for an exact identity, and conflicts on identity reuse', async () => {
      const fixture = factory();
      const journal = await open(fixture);
      const first = await journal.reserveIntent(intent());
      expect(first).toMatchObject({
        kind: 'acknowledged',
        disposition: 'applied',
        record: { revision: 1 },
      });
      const again = await journal.reserveIntent(intent());
      expect(again).toMatchObject({
        kind: 'acknowledged',
        disposition: 'existing',
        record: { revision: 1 },
      });
      expect(await journal.reserveIntent(intent('op-1', 'different-actor'))).toEqual({
        kind: 'conflict',
        reason: 'identity',
      });
      expect(fixture.observe('deployment-a')?.records).toHaveLength(1);
      expect(fixture.observe('deployment-a')?.reservedBytes).toBe(16_384);
    });

    it('atomically marks dispatch once and preserves the original predecessor retry', async () => {
      const fixture = factory();
      const { journal, record } = await reserve(fixture);
      const transition: JournalTransition = { identity: record.identity, expectedRevision: 1 };
      const [left, right] = await Promise.all([
        journal.markDispatch(transition),
        journal.markDispatch(transition),
      ]);
      expect(
        [left, right]
          .map((result) => (result.kind === 'acknowledged' ? result.disposition : result.kind))
          .sort()
      ).toEqual(['already_applied', 'applied']);
      expect(fixture.observe('deployment-a')?.records[0]).toMatchObject({
        revision: 2,
        dispatched: true,
      });
    });

    it('commits immutable terminal facts and never treats a terminal record as a dispatch ACK', async () => {
      const fixture = factory();
      const { journal, record } = await reserve(fixture);
      const dispatch: JournalTransition = { identity: record.identity, expectedRevision: 1 };
      await journal.markDispatch(dispatch);
      const terminal: JournalTerminalTransition = {
        identity: record.identity,
        expectedRevision: 2,
        dispatched: true,
        terminal: { status: 'completed', evidenceRefIds: ['evidence-1'] },
      };
      expect(await journal.commitTerminal(terminal)).toMatchObject({
        kind: 'acknowledged',
        disposition: 'applied',
        record: { revision: 3 },
      });
      expect(await journal.commitTerminal(terminal)).toMatchObject({
        kind: 'acknowledged',
        disposition: 'already_applied',
        record: { revision: 3 },
      });
      expect(await journal.markDispatch(dispatch)).toEqual({
        kind: 'conflict',
        reason: 'operation_terminal',
      });
      expect(
        await journal.commitTerminal({
          ...terminal,
          terminal: { status: 'failed', evidenceRefIds: ['evidence-1'] },
        })
      ).toEqual({ kind: 'conflict', reason: 'terminal_facts' });
      // The facade rejects a current-revision pseudo-retry before it reaches storage.
      expect(await journal.commitTerminal({ ...terminal, expectedRevision: 3 })).toEqual({
        kind: 'definitely_not_written',
        reason: 'invalid_request',
      });
      expect(fixture.observe('deployment-a')?.records[0]).toMatchObject({
        terminal: terminal.terminal,
      });
    });

    it('supports only failed pre-dispatch terminal records and keeps them terminal', async () => {
      const fixture = factory();
      const { journal, record } = await reserve(fixture);
      const failure: JournalTerminalTransition = {
        identity: record.identity,
        expectedRevision: 1,
        dispatched: false,
        terminal: { status: 'failed', evidenceRefIds: [] },
      };
      expect(await journal.commitTerminal(failure)).toMatchObject({
        kind: 'acknowledged',
        record: { revision: 2, dispatched: false },
      });
      expect(await journal.commitTerminal(failure)).toMatchObject({
        kind: 'acknowledged',
        disposition: 'already_applied',
      });
      expect(
        await journal.markDispatch({ identity: record.identity, expectedRevision: 1 })
      ).toEqual({ kind: 'conflict', reason: 'operation_terminal' });
      expect(fixture.observe('deployment-a')?.records[0]).toMatchObject({
        revision: 2,
        dispatched: false,
        terminal: { status: 'failed' },
      });
    });

    it('enforces one writer, full namespace descriptors, and transaction-time fences', async () => {
      const fixture = factory();
      const first = await open(fixture);
      expect(
        await openOperationJournal(fixture.adapter, namespace(), fixture.fingerprintKey)
      ).toEqual({ kind: 'definitely_not_opened', reason: 'ownership' });
      fixture.releaseOwnership('deployment-a');
      const replacement = await open(fixture);
      expect(await first.reserveIntent(intent('old-owner'))).toEqual({
        kind: 'definitely_not_written',
        reason: 'fenced',
      });
      expect(await replacement.reserveIntent(intent('new-owner'))).toMatchObject({
        kind: 'acknowledged',
        disposition: 'applied',
      });
      expect(
        fixture.observe('deployment-a')?.records.map((value) => value.identity.key.operationId)
      ).toEqual(['new-owner']);
      await replacement.close();
      expect(
        await openOperationJournal(
          fixture.adapter,
          { ...namespace(), restoreGeneration: 'operator-generation-2' },
          fixture.fingerprintKey
        )
      ).toEqual({ kind: 'definitely_not_opened', reason: 'configuration' });
      expect(
        await openOperationJournal(
          fixture.adapter,
          { ...namespace(), fingerprintKeyId: 'key-2' },
          fixture.fingerprintKey
        )
      ).toEqual({ kind: 'definitely_not_opened', reason: 'configuration' });
      expect(await openOperationJournal(fixture.adapter, namespace(), Buffer.alloc(32, 8))).toEqual(
        { kind: 'definitely_not_opened', reason: 'configuration' }
      );
      const rawDescriptor = fixture.observe('deployment-a')?.descriptor;
      if (!rawDescriptor) throw new Error();
      expect(
        await Promise.resolve(
          fixture.adapter.open(
            { ...rawDescriptor, schemaVersion: 2 as 1 },
            new AbortController().signal
          )
        )
      ).toEqual({ kind: 'definitely_not_opened', reason: 'configuration' });
    });

    it('uses one immutable store-wide namespace ceiling that a later namespace cannot widen', async () => {
      const fixture = factory();
      await open(fixture, { ...namespace(), namespaceId: 'deployment-a' });
      await open(fixture, { ...namespace(), namespaceId: 'deployment-b' });
      expect(
        await openOperationJournal(
          fixture.adapter,
          { ...namespace(), namespaceId: 'deployment-c' },
          fixture.fingerprintKey
        )
      ).toEqual({ kind: 'definitely_not_opened', reason: 'capacity' });
      expect(
        await openOperationJournal(
          fixture.adapter,
          {
            ...namespace(),
            namespaceId: 'deployment-c',
            bounds: { ...namespace().bounds, maxNamespaces: 3 },
          },
          fixture.fingerprintKey
        )
      ).toEqual({ kind: 'definitely_not_opened', reason: 'configuration' });
      expect(fixture.observe('deployment-c')).toBeUndefined();
    });

    it('scopes lookup by the complete key without cross-namespace disclosure', async () => {
      const fixture = factory();
      const { journal, record } = await reserve(fixture);
      expect(await journal.lookup(record.identity.key)).toMatchObject({
        kind: 'found',
        record: { identity: record.identity },
      });
      expect(
        await journal.lookup({ ...record.identity.key, sessionIncarnation: 'x'.repeat(22) })
      ).toEqual({ kind: 'scoped_absent' });
      await journal.close();
      const other = await open(fixture, { ...namespace(), namespaceId: 'deployment-b' });
      expect(await other.lookup(record.identity.key)).toEqual({ kind: 'scoped_absent' });
    });

    it('applies capacity and fixed horizons atomically without evicting admitted records', async () => {
      const fixture = factory();
      const configuration = namespace({ bounds: { ...namespace().bounds, maxRecords: 1 } });
      const journal = await open(fixture, configuration);
      const first = await journal.reserveIntent(intent());
      expect(first).toMatchObject({ kind: 'acknowledged', disposition: 'applied' });
      expect(await journal.reserveIntent(intent('op-2'))).toEqual({
        kind: 'definitely_not_written',
        reason: 'capacity',
      });
      fixture.advance(1_001);
      expect(await journal.reserveIntent(intent())).toMatchObject({
        kind: 'acknowledged',
        disposition: 'existing',
      });
      if (first.kind !== 'acknowledged') throw new Error();
      const dispatch = await journal.markDispatch({
        identity: first.record.identity,
        expectedRevision: 1,
      });
      expect(dispatch).toMatchObject({ kind: 'acknowledged', record: { revision: 2 } });
      expect(
        await journal.commitTerminal({
          identity: first.record.identity,
          expectedRevision: 2,
          dispatched: true,
          terminal: { status: 'outcome_unknown', evidenceRefIds: [] },
        })
      ).toMatchObject({ kind: 'acknowledged', record: { revision: 3 } });
      expect(fixture.observe('deployment-a')?.records).toHaveLength(1);
      expect(await journal.reserveIntent(intent('op-3'))).toEqual({
        kind: 'definitely_not_written',
        reason: 'admission_expired',
      });
      fixture.advance(3_000);
      expect(await journal.lookup(first.record.identity.key)).toEqual({
        kind: 'definitely_not_read',
        reason: 'expired',
      });
    });

    it('distinguishes failure location through independent durable observation', async () => {
      const before = factory();
      const beforeJournal = await open(before);
      before.failNext('reserveIntent', 'before_write');
      expect(await beforeJournal.reserveIntent(intent())).toEqual({
        kind: 'uncertain',
        reason: 'io',
      });
      expect(before.observe('deployment-a')?.records).toHaveLength(0);

      const after = factory();
      const afterJournal = await open(after);
      after.failNext('reserveIntent', 'after_commit');
      expect(await afterJournal.reserveIntent(intent())).toEqual({
        kind: 'uncertain',
        reason: 'io',
      });
      expect(after.observe('deployment-a')?.records).toHaveLength(1);
    });

    it('keeps a never-settling store call pending and state absent after the public wait expires', async () => {
      vi.useFakeTimers();
      const fixture = factory();
      const journal = await open(fixture);
      fixture.failNext('reserveIntent', 'never_settles');
      const result = journal.reserveIntent(intent());
      await vi.advanceTimersByTimeAsync(26);
      expect(await result).toEqual({ kind: 'uncertain', reason: 'wait_expired' });
      expect(journal.pending).toBe(1);
      expect(fixture.observe('deployment-a')?.records).toHaveLength(0);
    });
  });
}
