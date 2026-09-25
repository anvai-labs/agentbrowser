import type { OperationRecord } from '@agentbrowser/protocol';

/** Internal storage contract. None of these shapes grant execution or historical access. */
export interface JournalKey {
  readonly serviceGeneration: string;
  readonly tenantId: string;
  readonly sessionIncarnation: string;
  readonly epoch: number;
  readonly operationId: string;
}
export interface JournalApplication {
  readonly adapterId: string;
  readonly resourceId: string;
  readonly bindingGeneration: string;
}
export interface JournalIntent {
  readonly key: JournalKey;
  readonly actor: string;
  readonly application?: JournalApplication;
  readonly liveFingerprint: { readonly algorithm: string; readonly digest: string };
}
export interface JournalIdentity {
  readonly key: JournalKey;
  readonly actor: string;
  readonly application?: JournalApplication;
  readonly fingerprint: { readonly version: 1; readonly keyId: string; readonly digest: string };
}
export interface JournalTerminal {
  readonly status: Exclude<OperationRecord['status'], 'in_flight'>;
  readonly evidenceRefIds: readonly string[];
}
export interface JournalRecord {
  readonly schemaVersion: 1;
  readonly namespaceId: string;
  readonly identity: JournalIdentity;
  readonly revision: 1 | 2 | 3;
  readonly intent: true;
  readonly dispatched: boolean;
  readonly terminal?: JournalTerminal;
}
export interface JournalBounds {
  readonly maxRecordBytes: number;
  readonly maxRecords: number;
  readonly maxNamespaces: number;
  readonly maxInFlight: number;
  readonly timeoutMs: number;
}
export interface JournalNamespace {
  readonly schemaVersion: 1;
  readonly namespaceId: string;
  readonly fingerprintVersion: 1;
  readonly fingerprintKeyId: string;
  readonly restoreGeneration: string;
  readonly acceptUntil: number;
  readonly retainUntil: number;
  readonly maxFinalizationMs: number;
  readonly bounds: JournalBounds;
}
export type JournalNoWriteReason =
  | 'invalid_request'
  | 'aborted'
  | 'capacity'
  | 'closed'
  | 'fenced'
  | 'expired'
  | 'admission_expired'
  | 'quarantined'
  | 'poisoned'
  | 'unavailable';
export type JournalConflictReason =
  | 'identity'
  | 'revision'
  | 'missing_intent'
  | 'operation_terminal'
  | 'terminal_facts';
export type JournalUncertainReason = 'io' | 'wait_expired' | 'invalid_response';
export type JournalMutationOutcome =
  | {
      readonly kind: 'acknowledged';
      readonly disposition: 'applied' | 'already_applied' | 'existing';
      readonly record: JournalRecord;
    }
  | { readonly kind: 'definitely_not_written'; readonly reason: JournalNoWriteReason }
  | { readonly kind: 'conflict'; readonly reason: JournalConflictReason }
  | { readonly kind: 'uncertain'; readonly reason: JournalUncertainReason };
export type JournalLookupOutcome =
  | { readonly kind: 'found'; readonly record: JournalRecord }
  | { readonly kind: 'scoped_absent' }
  | { readonly kind: 'definitely_not_read'; readonly reason: JournalNoWriteReason }
  | { readonly kind: 'uncertain'; readonly reason: JournalUncertainReason };
export type JournalCloseOutcome =
  | { readonly kind: 'closed' }
  | { readonly kind: 'uncertain'; readonly reason: JournalUncertainReason };
export interface JournalTransition {
  readonly identity: JournalIdentity;
  readonly expectedRevision: number;
}
export interface JournalTerminalTransition extends JournalTransition {
  readonly dispatched: boolean;
  readonly terminal: JournalTerminal;
}
export interface JournalStamp {
  readonly namespaceId: string;
  readonly ownerFence: string;
}
export type Stamped<T> = JournalStamp & { readonly value: T };
/** Raw adapter owns atomic CAS, fencing, capacity reservation and durable acknowledgment. */
export interface RawOperationJournalHandle {
  reserveIntent(request: Stamped<JournalTransition>, signal: AbortSignal): PromiseLike<unknown>;
  markDispatch(request: Stamped<JournalTransition>, signal: AbortSignal): PromiseLike<unknown>;
  commitTerminal(
    request: Stamped<JournalTerminalTransition>,
    signal: AbortSignal
  ): PromiseLike<unknown>;
  lookup(request: Stamped<JournalKey>, signal: AbortSignal): PromiseLike<unknown>;
  close(signal: AbortSignal): PromiseLike<unknown>;
}
export interface RawJournalNamespace extends JournalNamespace {
  readonly fingerprintKeyCheck: string;
}
export type RawJournalOpenOutcome =
  | {
      readonly kind: 'opened';
      readonly namespace: RawJournalNamespace;
      readonly ownerFence: string;
      readonly handle: RawOperationJournalHandle;
    }
  | {
      readonly kind: 'definitely_not_opened';
      readonly reason: 'ownership' | 'configuration' | 'capacity' | 'expired';
    }
  | { readonly kind: 'uncertain'; readonly reason: JournalUncertainReason };
export interface RawOperationJournalAdapter {
  open(namespace: RawJournalNamespace, signal: AbortSignal): PromiseLike<unknown>;
}
export interface OperationJournal {
  readonly namespace: JournalNamespace;
  readonly health: 'open' | 'quarantined' | 'poisoned' | 'closed';
  readonly pending: number;
  reserveIntent(intent: JournalIntent, signal?: AbortSignal): Promise<JournalMutationOutcome>;
  markDispatch(
    transition: JournalTransition,
    signal?: AbortSignal
  ): Promise<JournalMutationOutcome>;
  commitTerminal(
    transition: JournalTerminalTransition,
    signal?: AbortSignal
  ): Promise<JournalMutationOutcome>;
  lookup(key: JournalKey, signal?: AbortSignal): Promise<JournalLookupOutcome>;
  close(): Promise<JournalCloseOutcome>;
}
export type JournalOpenOutcome =
  | { readonly kind: 'opened'; readonly journal: OperationJournal }
  | {
      readonly kind: 'definitely_not_opened';
      readonly reason:
        | 'invalid_configuration'
        | 'aborted'
        | 'ownership'
        | 'configuration'
        | 'capacity'
        | 'expired';
    }
  | { readonly kind: 'uncertain'; readonly reason: JournalUncertainReason };
