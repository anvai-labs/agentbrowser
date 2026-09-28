/** Frozen owner-child IPC message shapes for the concrete SQLite journal (J2b.2 step 1).
 * Deliberately absent from the control barrel. The storage child speaks only these
 * messages plus process exit; fault hooks and clock control are test-only channels
 * and must never appear here. Error text never crosses IPC: a faulted child reports
 * `faulted` with no message, and the parent maps it to an uncertain outcome.
 */
import type { RawJournalNamespace } from './journal-types.js';

export type JournalChildMutationKind =
  | 'reserveIntent'
  | 'markDispatch'
  | 'commitTerminal'
  | 'lookup';

export type JournalChildRequest =
  | { readonly kind: 'open'; readonly openId: number; readonly descriptor: RawJournalNamespace }
  | {
      readonly kind: JournalChildMutationKind;
      readonly correlationId: number;
      readonly namespaceId: string;
      readonly ownerFence: string;
      readonly value: unknown;
    }
  | {
      readonly kind: 'close';
      readonly correlationId: number;
      readonly namespaceId: string;
      readonly ownerFence: string;
    };

export type JournalChildOpenResponse =
  | {
      readonly kind: 'opened';
      readonly openId: number;
      readonly namespace: RawJournalNamespace;
      readonly ownerFence: string;
    }
  | {
      readonly kind: 'definitely_not_opened';
      readonly openId: number;
      readonly reason: 'ownership' | 'configuration' | 'capacity' | 'expired';
    }
  | { readonly kind: 'uncertain'; readonly openId: number; readonly reason: 'io' }
  | { readonly kind: 'faulted'; readonly openId: number };

export type JournalChildCallResponse = {
  readonly kind: 'outcome' | 'faulted';
  readonly correlationId: number;
  /** Stamped envelope `{namespaceId, ownerFence, value}` when kind is 'outcome'. */
  readonly outcome?: unknown;
};

const boundedId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const boundedText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 2048;
const fencePattern = /^[A-Za-z0-9_-]{1,128}$/;

/** Structural guard for parent-to-child messages; values are validated by their owners. */
export function isJournalChildRequest(input: unknown): input is JournalChildRequest {
  if (!input || typeof input !== 'object') return false;
  const request = input as Record<string, unknown>;
  if (request.kind === 'open') {
    // The descriptor's own validity (schemaVersion, bounds, key check) is evaluated by
    // descriptor equality in the record state machine, so a malformed or newer-shaped
    // descriptor surfaces as `configuration`, never as a transport fault.
    if (!boundedId(request.openId) || !request.descriptor || typeof request.descriptor !== 'object')
      return false;
    const descriptor = request.descriptor as Record<string, unknown>;
    return boundedText(descriptor.namespaceId);
  }
  if (request.kind === 'close')
    return (
      boundedId(request.correlationId) &&
      boundedText(request.namespaceId) &&
      typeof request.ownerFence === 'string' &&
      fencePattern.test(request.ownerFence)
    );
  if (
    request.kind === 'reserveIntent' ||
    request.kind === 'markDispatch' ||
    request.kind === 'commitTerminal' ||
    request.kind === 'lookup'
  )
    return (
      boundedId(request.correlationId) &&
      boundedText(request.namespaceId) &&
      typeof request.ownerFence === 'string' &&
      fencePattern.test(request.ownerFence) &&
      request.value !== undefined
    );
  return false;
}
