import { createMemoryJournalFixture } from './journal-conformance.test-support.js';
import type {
  JournalNamespace,
  RawJournalOpenOutcome,
  RawOperationJournalAdapter,
  RawOperationJournalHandle,
} from './journal-types.js';
import { openOperationJournal } from './operation-journal.js';

export type RawMutation = 'reserveIntent' | 'markDispatch' | 'commitTerminal' | 'lookup';
type HoldPhase = 'before_write' | 'after_commit';

export interface HeldJournalCall {
  readonly started: Promise<void>;
  readonly committed: Promise<void>;
  release(): void;
}

export function namespace(overrides: Partial<JournalNamespace> = {}): JournalNamespace {
  return {
    schemaVersion: 1,
    namespaceId: 'session-authority-c1',
    fingerprintVersion: 1,
    fingerprintKeyId: 'test-key-1',
    restoreGeneration: 'test-restore-1',
    acceptUntil: 10_000,
    retainUntil: 20_000,
    maxFinalizationMs: 1_000,
    bounds: {
      maxRecordBytes: 16_384,
      maxRecords: 16,
      maxNamespaces: 2,
      maxInFlight: 4,
      timeoutMs: 25,
    },
    ...overrides,
  };
}

/** Delay only test transport/mutation acknowledgment; memory state stays independently observable. */
export function controllableAdapter(base: RawOperationJournalAdapter) {
  const queues = new Map<
    RawMutation,
    Array<{
      phase: HoldPhase;
      started: ReturnType<typeof Promise.withResolvers<void>>;
      committed: ReturnType<typeof Promise.withResolvers<void>>;
      release: ReturnType<typeof Promise.withResolvers<void>>;
    }>
  >();
  const calls: Record<RawMutation, number> = {
    reserveIntent: 0,
    markDispatch: 0,
    commitTerminal: 0,
    lookup: 0,
  };
  const dispositions = new Map<RawMutation, Array<'applied' | 'already_applied' | 'existing'>>();
  const holdNext = (method: RawMutation, phase: HoldPhase): HeldJournalCall => {
    const held = {
      phase,
      started: Promise.withResolvers<void>(),
      committed: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    queues.set(method, [...(queues.get(method) ?? []), held]);
    return {
      started: held.started.promise,
      committed: held.committed.promise,
      release: () => held.release.resolve(),
    };
  };
  const adapter: RawOperationJournalAdapter = {
    async open(request, signal) {
      const opened = (await base.open(request, signal)) as RawJournalOpenOutcome;
      if (opened.kind !== 'opened') return opened;
      const original = opened.handle;
      const invoke = (
        method: RawMutation,
        requestValue: unknown,
        requestSignal: AbortSignal
      ): PromiseLike<unknown> => {
        calls[method]++;
        const held = queues.get(method)?.shift();
        const disposition = dispositions.get(method)?.shift();
        held?.started.resolve();
        const call = original[method] as (
          request: unknown,
          signal: AbortSignal
        ) => PromiseLike<unknown>;
        const project = (result: unknown) => {
          if (
            disposition === undefined ||
            !result ||
            typeof result !== 'object' ||
            !('value' in result) ||
            !result.value ||
            typeof result.value !== 'object' ||
            !('kind' in result.value) ||
            result.value.kind !== 'acknowledged'
          )
            return result;
          return { ...result, value: { ...result.value, disposition } };
        };
        if (!held) return Promise.resolve(call(requestValue, requestSignal)).then(project);
        if (held.phase === 'before_write') {
          return held.release.promise.then(async () => {
            const result = project(await call(requestValue, requestSignal));
            held.committed.resolve();
            return result;
          });
        }
        return Promise.resolve(call(requestValue, requestSignal)).then(
          (result) => {
            held.committed.resolve();
            return held.release.promise.then(() => project(result));
          },
          (error) => {
            held.committed.resolve();
            return held.release.promise.then(() => Promise.reject(error));
          }
        );
      };
      const handle: RawOperationJournalHandle = {
        reserveIntent: (value, abort) => invoke('reserveIntent', value, abort),
        markDispatch: (value, abort) => invoke('markDispatch', value, abort),
        commitTerminal: (value, abort) => invoke('commitTerminal', value, abort),
        lookup: (value, abort) => invoke('lookup', value, abort),
        close: (abort) => original.close(abort),
      };
      return { ...opened, handle };
    },
  };
  const rewriteNextDisposition = (
    method: RawMutation,
    disposition: 'applied' | 'already_applied' | 'existing'
  ) => {
    dispositions.set(method, [...(dispositions.get(method) ?? []), disposition]);
  };
  return { adapter, calls, holdNext, rewriteNextDisposition };
}

export async function createControllableJournalFixture(configuration = namespace()) {
  const memory = createMemoryJournalFixture();
  const controlled = controllableAdapter(memory.adapter);
  const opened = await openOperationJournal(
    controlled.adapter,
    configuration,
    memory.fingerprintKey
  );
  if (opened.kind !== 'opened') throw new Error('journal fixture did not open');
  return { memory, controlled, journal: opened.journal };
}
