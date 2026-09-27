import { canonicalJson } from '@agentbrowser/core';
import {
  CONTROL_OPERATION_ID,
  EvidenceReferenceIdsSchema,
  parseExecutionReport,
  snapshotJsonData,
} from '@agentbrowser/protocol';
import type {
  JournalIdentity,
  JournalIntent,
  JournalKey,
  JournalNamespace,
  JournalRecord,
  JournalTerminal,
  JournalTerminalTransition,
  JournalTransition,
} from './journal-types.js';
import { deeplyFreezeSnapshot } from './trusted-callback.js';

const limits = Object.freeze({ maxDepth: 12, maxNodes: 1024, maxBytes: 65536 });
const invalid = (): never => {
  throw new Error('Invalid journal metadata');
};
/** Shared detachment and exact encoded-byte budget, before domain validation. */
export function journalData(input: unknown, maxBytes: number = limits.maxBytes): unknown {
  const value = snapshotJsonData(input, { ...limits, maxBytes });
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > maxBytes) invalid();
  return value;
}
export function journalObject(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid();
  return value;
}
function text(input: unknown, max = 256): asserts input is string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max) invalid();
}
function integer(input: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts input is number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max)
    invalid();
}
function identifier(input: unknown): asserts input is string {
  if (typeof input !== 'string' || !CONTROL_OPERATION_ID.test(input)) invalid();
}
function generation(input: unknown) {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(input)) invalid();
}
function key(input: unknown): asserts input is JournalKey {
  const v = journalObject(input, [
    'serviceGeneration',
    'tenantId',
    'sessionIncarnation',
    'epoch',
    'operationId',
  ]);
  generation(v.serviceGeneration);
  generation(v.sessionIncarnation);
  text(v.tenantId);
  integer(v.epoch);
  identifier(v.operationId);
}
function baseIdentity(v: Record<string, unknown>) {
  key(v.key);
  text(v.actor);
  if (v.application !== undefined) {
    const app = journalObject(v.application, ['adapterId', 'resourceId', 'bindingGeneration']);
    text(app.adapterId, 128);
    text(app.resourceId);
    text(app.bindingGeneration, 128);
  }
}
function identity(input: unknown, namespace: JournalNamespace): asserts input is JournalIdentity {
  const v = journalObject(input, ['key', 'actor', 'fingerprint'], ['application']);
  baseIdentity(v);
  const f = journalObject(v.fingerprint, ['version', 'keyId', 'digest']);
  if (
    f.version !== 1 ||
    f.keyId !== namespace.fingerprintKeyId ||
    typeof f.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(f.digest)
  )
    invalid();
}
function terminal(input: unknown): asserts input is JournalTerminal {
  const v = journalObject(input, ['status', 'evidenceRefIds']);
  if (!['completed', 'failed', 'outcome_unknown'].includes(v.status as string)) invalid();
  parseExecutionReport(
    EvidenceReferenceIdsSchema,
    v.evidenceRefIds,
    'journal evidence',
    undefined,
    limits
  );
}
export function parseJournalNamespace(input: unknown): JournalNamespace {
  const v = journalObject(journalData(input), [
    'schemaVersion',
    'namespaceId',
    'fingerprintVersion',
    'fingerprintKeyId',
    'restoreGeneration',
    'acceptUntil',
    'retainUntil',
    'maxFinalizationMs',
    'bounds',
  ]);
  if (v.schemaVersion !== 1 || v.fingerprintVersion !== 1) invalid();
  identifier(v.namespaceId);
  identifier(v.fingerprintKeyId);
  identifier(v.restoreGeneration);
  integer(v.acceptUntil, 1);
  integer(v.retainUntil, 1);
  integer(v.maxFinalizationMs, 1);
  if (v.retainUntil - v.acceptUntil < v.maxFinalizationMs) invalid();
  const b = journalObject(v.bounds, [
    'maxRecordBytes',
    'maxRecords',
    'maxNamespaces',
    'maxInFlight',
    'timeoutMs',
  ]);
  integer(b.maxRecordBytes, 1024, limits.maxBytes);
  integer(b.maxRecords, 1);
  integer(b.maxNamespaces, 1);
  integer(b.maxInFlight, 1, 1024);
  integer(b.timeoutMs, 1, 60000);
  return deeplyFreezeSnapshot(v) as unknown as JournalNamespace;
}
export function parseJournalKey(input: unknown): JournalKey {
  const v = journalData(input);
  key(v);
  return deeplyFreezeSnapshot(v);
}
export function parseJournalIntent(input: unknown): JournalIntent {
  const v = journalObject(journalData(input), ['key', 'actor', 'liveFingerprint'], ['application']);
  baseIdentity(v);
  const f = journalObject(v.liveFingerprint, ['algorithm', 'digest']);
  text(f.algorithm, 128);
  text(f.digest, 4096);
  return deeplyFreezeSnapshot(v) as unknown as JournalIntent;
}
export function parseJournalTransition(
  input: unknown,
  namespace: JournalNamespace,
  isTerminal: true
): JournalTerminalTransition;
export function parseJournalTransition(
  input: unknown,
  namespace: JournalNamespace,
  isTerminal?: false
): JournalTransition;
export function parseJournalTransition(
  input: unknown,
  namespace: JournalNamespace,
  isTerminal = false
): JournalTransition | JournalTerminalTransition {
  const v = journalObject(
    journalData(input, namespace.bounds.maxRecordBytes),
    isTerminal
      ? ['identity', 'expectedRevision', 'dispatched', 'terminal']
      : ['identity', 'expectedRevision']
  );
  identity(v.identity, namespace);
  integer(v.expectedRevision, 0, 3);
  if (isTerminal) {
    if (typeof v.dispatched !== 'boolean') invalid();
    terminal(v.terminal);
    if (
      (!v.dispatched && v.terminal.status !== 'failed') ||
      v.expectedRevision !== (v.dispatched ? 2 : 1)
    )
      invalid();
  }
  return deeplyFreezeSnapshot(v) as unknown as JournalTransition;
}
export function parseJournalRecord(input: unknown, namespace: JournalNamespace): JournalRecord {
  const v = journalObject(
    journalData(input, namespace.bounds.maxRecordBytes),
    ['schemaVersion', 'namespaceId', 'identity', 'revision', 'intent', 'dispatched'],
    ['terminal']
  );
  if (
    v.schemaVersion !== 1 ||
    v.namespaceId !== namespace.namespaceId ||
    v.intent !== true ||
    typeof v.dispatched !== 'boolean'
  )
    invalid();
  identity(v.identity, namespace);
  if (v.terminal !== undefined) {
    terminal(v.terminal);
    if ((!v.dispatched && v.terminal.status !== 'failed') || v.revision !== (v.dispatched ? 3 : 2))
      invalid();
  } else if (v.revision !== (v.dispatched ? 2 : 1)) invalid();
  return deeplyFreezeSnapshot(v) as unknown as JournalRecord;
}
/** Reserve enough metadata space now for the largest terminal locator set. */
export function assertJournalCompletionFits(
  identity: JournalIdentity,
  namespace: JournalNamespace
): void {
  parseJournalRecord(
    {
      schemaVersion: 1,
      namespaceId: namespace.namespaceId,
      identity,
      revision: 3,
      intent: true,
      dispatched: true,
      terminal: {
        status: 'outcome_unknown',
        evidenceRefIds: Array.from({ length: 32 }, () => 'e'.repeat(128)),
      },
    },
    namespace
  );
}
