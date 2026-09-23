import { ControlError } from '@agentbrowser/core';
import type { OperationRecord } from '@agentbrowser/protocol';

export type TerminalStatus = Exclude<OperationRecord['status'], 'in_flight'>;
export interface SessionPublicationContext {
  readonly status: TerminalStatus;
  readonly signal: AbortSignal;
  /** Must be checked at the actual output boundary; conveys no execution authority. */
  assertCurrent(): void;
}

/** Trusted host composition only; not an HTTP option or a replay publisher. */
export interface SessionPublication<T> {
  readonly timeoutMs: number;
  /** Cancels publication only, never execution or its drain. */
  readonly signal?: AbortSignal;
  publish(value: T, context: Readonly<SessionPublicationContext>): void | PromiseLike<void>;
}

export function snapshotPublication<T>(options: SessionPublication<T>): SessionPublication<T> {
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
