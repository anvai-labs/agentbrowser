import { ControlError } from '@agentbrowser/core';
import type { OperationRecord } from '@agentbrowser/protocol';
import { TIMEOUT, within } from './bounded-wait.js';

export type TerminalStatus = Exclude<OperationRecord['status'], 'in_flight'>;
export interface PublicationContext {
  readonly signal: AbortSignal;
  /** Must be checked at actual output; conveys no execution authority. */
  assertCurrent(): void;
}
export interface SessionPublicationContext extends PublicationContext {
  readonly status: TerminalStatus;
}
interface PublicationSettings {
  readonly timeoutMs: number;
  /** Cancels publication only, never execution or its drain. */
  readonly signal?: AbortSignal;
}
interface Publication<T, Context extends PublicationContext = PublicationContext>
  extends PublicationSettings {
  publish(value: T, context: Readonly<Context>): void | PromiseLike<void>;
}
/** Trusted host composition only; not an HTTP option or a replay publisher. */
export interface SessionPublication<T> extends Publication<T, SessionPublicationContext> {}
/** Core-owned status lookup or replay only; never an arbitrary payload or effect. */
export interface OperationPublication extends Publication<Readonly<OperationRecord>> {}

export function snapshotPublication<T, Context extends PublicationContext>(
  options: Publication<T, Context>
): Publication<T, Context> {
  const timeoutMs = options.timeoutMs;
  const publish = options.publish;
  const signal = options.signal;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000 ||
    typeof publish !== 'function' ||
    (signal !== undefined && !(signal instanceof AbortSignal))
  )
    throw new ControlError('INVALID_REQUEST', 'Invalid publication options');
  return Object.freeze({ timeoutMs, publish, ...(signal ? { signal } : {}) });
}

/** Shared bounded output lifetime; each composition retains its existing owner policy. */
export async function publishWithin(
  options: PublicationSettings,
  assertOwner: () => void,
  now: () => number,
  publish: (context: Readonly<PublicationContext>) => void | PromiseLike<void>
): Promise<void> {
  const deadline = now() + options.timeoutMs;
  let open = true;
  const unavailable = () => new ControlError('CONTROL_REVOKED', 'Publication expired or revoked');
  try {
    const outcome = await within(
      async (signal) => {
        const assertCurrent = () => {
          try {
            if (!open || signal.aborted || now() >= deadline) throw unavailable();
            assertOwner();
          } catch (error) {
            open = false;
            throw error;
          }
        };
        assertCurrent();
        await publish(Object.freeze({ signal, assertCurrent }));
        assertCurrent();
      },
      options.timeoutMs,
      options.signal
    );
    if (outcome === TIMEOUT) throw unavailable();
  } finally {
    // Revoke even a non-cooperative publisher before its caller can release ownership.
    open = false;
  }
}
