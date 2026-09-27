import { createHmac } from 'node:crypto';
import { canonicalJson } from '@agentbrowser/core';
import { TIMEOUT, within } from './bounded-wait.js';
import {
  assertJournalCompletionFits,
  journalData,
  journalObject,
  parseJournalIntent,
  parseJournalKey,
  parseJournalNamespace,
  parseJournalRecord,
  parseJournalTransition,
} from './journal-record.js';
import type {
  JournalCall,
  JournalCloseOutcome,
  JournalConflictReason,
  JournalIdentity,
  JournalIntent,
  JournalKey,
  JournalLookupOutcome,
  JournalMutationOutcome,
  JournalNamespace,
  JournalNoWriteReason,
  JournalOpenOutcome,
  JournalTerminalTransition,
  JournalTransition,
  JournalUncertainReason,
  OperationJournal,
  RawOperationJournalAdapter,
  RawOperationJournalHandle,
  Stamped,
} from './journal-types.js';
import { deeplyFreezeSnapshot } from './trusted-callback.js';

const noWrite = (reason: JournalNoWriteReason): JournalMutationOutcome =>
  Object.freeze({ kind: 'definitely_not_written', reason });
const noRead = (reason: JournalNoWriteReason): JournalLookupOutcome =>
  Object.freeze({ kind: 'definitely_not_read', reason });
const uncertain = (reason: JournalUncertainReason) =>
  Object.freeze({ kind: 'uncertain' as const, reason });
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
// Decorate a native promise; awaiting it retains the existing bounded-outcome contract.
function journalCall<T>(outcome: Promise<T>, settled: Promise<void>): JournalCall<T> {
  return Object.defineProperty(outcome, 'settled', { value: settled }) as JournalCall<T>;
}
function settledCall<T>(outcome: T): JournalCall<T> {
  return journalCall(Promise.resolve(outcome), Promise.resolve());
}
type MutationMethod = 'reserveIntent' | 'markDispatch' | 'commitTerminal';
function badResponse(): never {
  throw new Error('Invalid journal acknowledgment');
}
const uncertainReasons = ['io', 'wait_expired', 'invalid_response'];
const noWriteReasons = [
  'capacity',
  'closed',
  'fenced',
  'expired',
  'admission_expired',
  'unavailable',
];
const conflicts: readonly JournalConflictReason[] = [
  'identity',
  'revision',
  'missing_intent',
  'operation_terminal',
  'terminal_facts',
];

/** Trusted capabilities are own data methods, captured once without invoking getters. */
function methods<T extends object>(input: unknown, names: readonly string[]): T {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype)
    badResponse();
  const bound: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'function'
    )
      badResponse();
    bound[name] = descriptor.value.bind(input);
  }
  return Object.freeze(bound) as T;
}

/** Internal only. Opening neither grants execution nor authorizes historical disclosure. */
export async function openOperationJournal(
  adapter: RawOperationJournalAdapter,
  input: JournalNamespace,
  fingerprintKey: Uint8Array,
  signal?: AbortSignal
): Promise<JournalOpenOutcome> {
  let namespace: JournalNamespace;
  let key: Buffer;
  let open: RawOperationJournalAdapter['open'];
  try {
    namespace = parseJournalNamespace(input);
    if (
      !(fingerprintKey instanceof Uint8Array) ||
      fingerprintKey.byteLength < 32 ||
      fingerprintKey.byteLength > 64
    )
      throw new Error();
    key = Buffer.from(fingerprintKey);
    open = methods<RawOperationJournalAdapter>(adapter, ['open']).open;
  } catch {
    return { kind: 'definitely_not_opened', reason: 'invalid_configuration' };
  }
  if (signal?.aborted) return { kind: 'definitely_not_opened', reason: 'aborted' };
  const storedNamespace = deeplyFreezeSnapshot({
    ...namespace,
    fingerprintKeyCheck: createHmac('sha256', key)
      .update('agentbrowser:operation-journal:key-check:v1\0')
      .update(
        canonicalJson({ namespaceId: namespace.namespaceId, keyId: namespace.fingerprintKeyId })
      )
      .digest('hex'),
  });
  let started = false;
  let received = false;
  let abandoned = false;
  let acquired: RawOperationJournalHandle | undefined;
  let releaseHandle: Pick<RawOperationJournalHandle, 'close'> | undefined;
  let cleanup: Promise<unknown> | undefined;
  const releaseAbandoned = () => {
    if (releaseHandle && !cleanup) {
      const handle = releaseHandle;
      cleanup = within((abort) => handle.close(abort), namespace.bounds.timeoutMs).catch(
        () => undefined
      );
    }
  };
  try {
    const result = await within(
      async (abortSignal): Promise<JournalOpenOutcome> => {
        if (abortSignal.aborted) return { kind: 'definitely_not_opened', reason: 'aborted' };
        started = true;
        const raw = await open(storedNamespace, abortSignal);
        received = true;
        try {
          // Split the capability from metadata using descriptors, never serializing a handle.
          if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype)
            badResponse();
          const own = Object.getOwnPropertyDescriptors(raw);
          if (
            Reflect.ownKeys(raw).some((name) => typeof name !== 'string') ||
            Object.values(own).some((d) => !d.enumerable || !Object.hasOwn(d, 'value'))
          )
            badResponse();
          if (own.kind?.value !== 'opened') {
            const negative = journalObject(journalData(raw), ['kind', 'reason']);
            if (
              negative.kind === 'definitely_not_opened' &&
              ['ownership', 'configuration', 'capacity', 'expired'].includes(
                negative.reason as string
              )
            )
              return Object.freeze(negative) as unknown as JournalOpenOutcome;
            if (
              negative.kind === 'uncertain' &&
              uncertainReasons.includes(negative.reason as string)
            )
              return uncertain(negative.reason as JournalUncertainReason);
            return badResponse();
          }
          if (Object.keys(own).length !== 4 || !own.namespace || !own.ownerFence || !own.handle)
            badResponse();
          releaseHandle = methods<Pick<RawOperationJournalHandle, 'close'>>(own.handle.value, [
            'close',
          ]);
          acquired = methods<RawOperationJournalHandle>(own.handle.value, [
            'reserveIntent',
            'markDispatch',
            'commitTerminal',
            'lookup',
            'close',
          ]);
          const actual = journalObject(journalData(own.namespace.value), [
            ...Object.keys(namespace),
            'fingerprintKeyCheck',
          ]);
          const fence = own.ownerFence.value;
          if (
            !equal(actual, storedNamespace) ||
            typeof fence !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(fence)
          )
            badResponse();
          if (abandoned) {
            releaseAbandoned();
            return uncertain('wait_expired');
          }
          return { kind: 'opened', journal: createJournal(namespace, fence, acquired, key) };
        } catch {
          abandoned = true;
          releaseAbandoned();
          return uncertain('invalid_response');
        }
      },
      namespace.bounds.timeoutMs,
      signal
    );
    if (result === TIMEOUT) {
      abandoned = true;
      releaseAbandoned();
      return started
        ? uncertain('wait_expired')
        : { kind: 'definitely_not_opened', reason: 'aborted' };
    }
    return result;
  } catch {
    abandoned = true;
    releaseAbandoned();
    return uncertain(received ? 'invalid_response' : 'io');
  }
}

function createJournal(
  namespace: JournalNamespace,
  ownerFence: string,
  raw: RawOperationJournalHandle,
  key: Buffer
): OperationJournal {
  let closed = false;
  let quarantined = false;
  let poisoned = false;
  let closing: Promise<JournalCloseOutcome> | undefined;
  const pending = new Set<Promise<unknown>>();
  // Reservations count before the microtask which invokes the adapter.
  let slots = 0;
  const health = () =>
    closed ? 'closed' : poisoned ? 'poisoned' : quarantined ? 'quarantined' : 'open';
  const stateRefusal = (write: boolean, signal?: AbortSignal): JournalNoWriteReason | undefined => {
    if (closed) return 'closed';
    if (poisoned) return 'poisoned';
    if (write && quarantined) return 'quarantined';
    if (signal?.aborted) return 'aborted';
    return undefined;
  };
  const stamp = <T>(value: T): Stamped<T> =>
    deeplyFreezeSnapshot({ namespaceId: namespace.namespaceId, ownerFence, value });
  const unstamp = (input: unknown): Record<string, unknown> => {
    const envelope = journalObject(journalData(input), ['namespaceId', 'ownerFence', 'value']);
    if (envelope.namespaceId !== namespace.namespaceId || envelope.ownerFence !== ownerFence)
      badResponse();
    return journalObject(envelope.value, ['kind'], ['reason', 'disposition', 'record']);
  };
  const negative = (
    value: Record<string, unknown>,
    operation: MutationMethod | 'lookup'
  ): JournalMutationOutcome | JournalLookupOutcome | undefined => {
    const write = operation !== 'lookup';
    if (value.kind === 'uncertain') {
      journalObject(value, ['kind', 'reason']);
      if (!uncertainReasons.includes(value.reason as string)) badResponse();
      if (value.reason === 'invalid_response') poisoned = true;
      quarantined = true;
      return uncertain(value.reason as JournalUncertainReason);
    }
    if (value.kind === (write ? 'definitely_not_written' : 'definitely_not_read')) {
      journalObject(value, ['kind', 'reason']);
      if (
        !noWriteReasons.includes(value.reason as string) ||
        (value.reason === 'admission_expired' && operation !== 'reserveIntent')
      )
        badResponse();
      if (['fenced', 'closed', 'expired'].includes(value.reason as string)) poisoned = true;
      return write
        ? noWrite(value.reason as JournalNoWriteReason)
        : noRead(value.reason as JournalNoWriteReason);
    }
    if (write && value.kind === 'conflict') {
      journalObject(value, ['kind', 'reason']);
      if (!conflicts.includes(value.reason as JournalConflictReason)) badResponse();
      return Object.freeze({ kind: 'conflict', reason: value.reason as JournalConflictReason });
    }
    return undefined;
  };

  function io<T extends JournalMutationOutcome | JournalLookupOutcome>(
    write: boolean,
    invoke: (signal: AbortSignal) => PromiseLike<unknown>,
    validate: (value: unknown) => T,
    signal?: AbortSignal
  ): JournalCall<T> {
    const refuse = (reason: JournalNoWriteReason) =>
      (write ? noWrite(reason) : noRead(reason)) as T;
    const refused =
      stateRefusal(write, signal) ??
      (slots >= namespace.bounds.maxInFlight ? 'capacity' : undefined);
    if (refused) return settledCall(refuse(refused));
    slots++;
    let started = false;
    let task: Promise<T> | undefined;
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const outcome = within(
      (abortSignal) => {
        // Reservation already counted; capacity cannot invalidate its own slot.
        const stopped = stateRefusal(write, abortSignal);
        if (stopped) return refuse(stopped);
        let stoppedBeforeIo: JournalNoWriteReason | undefined;
        // Attach both settlement branches before invoking a potentially throwing callback.
        task = Promise.resolve()
          .then(() => {
            // No await between the last cancellation/health check and adapter invocation.
            stoppedBeforeIo = stateRefusal(write, abortSignal);
            if (stoppedBeforeIo) return undefined;
            started = true;
            return invoke(abortSignal);
          })
          .then(
            (value): T => {
              if (stoppedBeforeIo) return refuse(stoppedBeforeIo);
              try {
                return validate(value);
              } catch {
                poisoned = true;
                quarantined = true;
                return uncertain('invalid_response') as T;
              }
            },
            (): T => {
              quarantined = true;
              return uncertain('io') as T;
            }
          );
        pending.add(task);
        void task.then(() => {
          slots--;
          pending.delete(task as Promise<T>);
          resolveSettled();
        });
        return task;
      },
      namespace.bounds.timeoutMs,
      signal
    )
      .then((result): T => {
        if (result === TIMEOUT) {
          if (!started) return refuse('aborted');
          quarantined = true;
          return uncertain('wait_expired') as T;
        }
        return result;
      })
      .finally(() => {
        if (!task) {
          slots--;
          resolveSettled();
        }
      });
    return journalCall(outcome, settled);
  }

  function mutate(
    kind: MutationMethod,
    input: JournalTransition | JournalTerminalTransition,
    signal?: AbortSignal
  ): JournalCall<JournalMutationOutcome> {
    const request = stamp(input);
    return io(
      true,
      (abort) => raw[kind](request as Stamped<JournalTerminalTransition>, abort),
      (rawResult) => {
        const value = unstamp(rawResult);
        const refusal = negative(value, kind);
        if (refusal) return refusal as JournalMutationOutcome;
        journalObject(value, ['kind', 'disposition', 'record']);
        if (value.kind !== 'acknowledged') badResponse();
        const record = parseJournalRecord(value.record, namespace);
        if (!equal(record.identity, input.identity)) badResponse();
        if (kind === 'reserveIntent') {
          if (
            value.disposition !== 'existing' &&
            !(value.disposition === 'applied' && record.revision === 1)
          )
            badResponse();
        } else {
          if (
            !['applied', 'already_applied'].includes(value.disposition as string) ||
            record.revision !== input.expectedRevision + 1
          )
            badResponse();
          if (
            kind === 'markDispatch' &&
            (!record.dispatched || record.terminal || record.revision !== 2)
          )
            badResponse();
          if (kind === 'commitTerminal') {
            const terminal = input as JournalTerminalTransition;
            if (
              record.dispatched !== terminal.dispatched ||
              !equal(record.terminal, terminal.terminal)
            )
              badResponse();
          }
        }
        return deeplyFreezeSnapshot({
          kind: 'acknowledged',
          disposition: value.disposition,
          record,
        }) as JournalMutationOutcome;
      },
      signal
    );
  }

  return Object.freeze({
    namespace,
    get health() {
      return health();
    },
    get pending() {
      return slots;
    },
    reserveIntent(input: JournalIntent, signal?: AbortSignal): JournalCall<JournalMutationOutcome> {
      let identity: JournalIdentity;
      try {
        const { liveFingerprint, ...base } = parseJournalIntent(input);
        const digest = createHmac('sha256', key)
          .update('agentbrowser:operation-journal:fingerprint:v1\0')
          .update(
            canonicalJson({
              namespaceId: namespace.namespaceId,
              keyId: namespace.fingerprintKeyId,
              ...base,
              liveFingerprint,
            })
          )
          .digest('hex');
        identity = deeplyFreezeSnapshot({
          ...base,
          fingerprint: { version: 1, keyId: namespace.fingerprintKeyId, digest },
        }) as JournalIdentity;
        assertJournalCompletionFits(identity, namespace);
      } catch {
        return settledCall(noWrite('invalid_request'));
      }
      return mutate('reserveIntent', { identity, expectedRevision: 0 }, signal);
    },
    markDispatch(
      input: JournalTransition,
      signal?: AbortSignal
    ): JournalCall<JournalMutationOutcome> {
      let transition: JournalTransition;
      try {
        transition = parseJournalTransition(input, namespace);
        if (transition.expectedRevision !== 1) return settledCall(noWrite('invalid_request'));
      } catch {
        return settledCall(noWrite('invalid_request'));
      }
      return mutate('markDispatch', transition, signal);
    },
    commitTerminal(
      input: JournalTerminalTransition,
      signal?: AbortSignal
    ): JournalCall<JournalMutationOutcome> {
      let transition: JournalTerminalTransition;
      try {
        transition = parseJournalTransition(input, namespace, true);
      } catch {
        return settledCall(noWrite('invalid_request'));
      }
      return mutate('commitTerminal', transition, signal);
    },
    lookup(input: JournalKey, signal?: AbortSignal): JournalCall<JournalLookupOutcome> {
      let key: JournalKey;
      try {
        key = parseJournalKey(input);
      } catch {
        return settledCall(noRead('invalid_request'));
      }
      return io(
        false,
        (abort) => raw.lookup(stamp(key), abort),
        (rawResult) => {
          const value = unstamp(rawResult);
          const refusal = negative(value, 'lookup');
          if (refusal) return refusal as JournalLookupOutcome;
          if (value.kind === 'scoped_absent') {
            journalObject(value, ['kind']);
            return Object.freeze({ kind: 'scoped_absent' });
          }
          journalObject(value, ['kind', 'record']);
          if (value.kind !== 'found') badResponse();
          const record = parseJournalRecord(value.record, namespace);
          if (!equal(record.identity.key, key)) badResponse();
          return deeplyFreezeSnapshot({ kind: 'found', record });
        },
        signal
      );
    },
    close(): Promise<JournalCloseOutcome> {
      if (closing) return closing;
      closed = true;
      // Cleanup waits for actual outstanding transactions; waiter expiration cannot free ownership.
      const task = Promise.allSettled([...pending])
        .then(() => raw.close(new AbortController().signal))
        .then(
          (result): JournalCloseOutcome => {
            try {
              const value = journalObject(journalData(result), ['kind'], ['reason']);
              if (value.kind === 'closed') {
                journalObject(value, ['kind']);
                return Object.freeze({ kind: 'closed' });
              }
              if (value.kind === 'uncertain' && uncertainReasons.includes(value.reason as string))
                return uncertain(value.reason as JournalUncertainReason);
            } catch {
              /* Static result only. */
            }
            return uncertain('invalid_response');
          },
          () => uncertain('io')
        );
      closing = within(() => task, namespace.bounds.timeoutMs).then((result) =>
        result === TIMEOUT ? uncertain('wait_expired') : result
      );
      return closing;
    },
  });
}
