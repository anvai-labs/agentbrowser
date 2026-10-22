/** Journal record/namespace semantics over the concrete SQLite store (J2b.2 step 1).
 * Deliberately absent from the control barrel and from any public service wiring.
 *
 * Owns the frozen v1 record schema and the record/CAS/namespace state machine that
 * `openJournalSqliteStore` deliberately does not: the storage owner owns exclusivity,
 * the commit witness and the anchor; this module owns descriptor equality, fences,
 * revision CAS, capacity reservation and time horizons, mirroring the storage-neutral
 * conformance semantics in journal-conformance.test-support.ts. Every function that
 * writes runs inside one owner `mutate` commit unit; expected negative outcomes are
 * returned as values because any throw seals the store as uncertain.
 */
import { canonicalJson } from '@agentbrowser/core';
import type { JournalSqliteTransaction } from './journal-sqlite-store.js';
import type {
  JournalKey,
  JournalRecord,
  JournalTerminalTransition,
  JournalTransition,
  RawJournalNamespace,
} from './journal-types.js';

/** The frozen v1 record schema. Changing any DDL is a new formatVersion, not a migration. */
const recordSchema = [
  `CREATE TABLE IF NOT EXISTS journal_namespace (
  namespace_id TEXT NOT NULL PRIMARY KEY,
  descriptor TEXT NOT NULL,
  active_fence TEXT,
  fence_serial INTEGER NOT NULL,
  reserved_bytes INTEGER NOT NULL,
  clock_high_water INTEGER NOT NULL
) STRICT`,
  `CREATE TABLE IF NOT EXISTS journal_record (
  namespace_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  identity TEXT NOT NULL,
  revision INTEGER NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (namespace_id, record_key),
  FOREIGN KEY (namespace_id) REFERENCES journal_namespace(namespace_id)
) STRICT`,
];

export function ensureJournalSqliteRecordSchema(transaction: JournalSqliteTransaction): void {
  for (const ddl of recordSchema) transaction.exec(ddl);
}

/**
 * Minimal read surface shared by the owner transaction facade and the separate
 * read-only observation connection, so refusal logic cannot diverge between them.
 */
export interface JournalSqliteReader {
  get(sql: string, ...parameters: unknown[]): Record<string, unknown> | undefined;
}

/** A live SQLite connection, viewed structurally: this module owns record semantics, not the
 * node:sqlite dependency. */
export interface JournalSqliteStatementConnection {
  prepare(sql: string): {
    get(...parameters: never[]): unknown;
    all(...parameters: never[]): unknown[];
  };
}

/**
 * Read-side statement adapters over a live connection (J2b.2). Statement cleanup follows the
 * owner's idiom: database.close() finalizes owned statements; none escape this helper.
 */
export function journalSqliteStatementReader(
  connection: JournalSqliteStatementConnection
): JournalSqliteReader & {
  all(sql: string, ...parameters: unknown[]): Record<string, unknown>[];
} {
  return {
    get: (sql: string, ...parameters: unknown[]) =>
      connection.prepare(sql).get(...(parameters as never[])) as
        | Record<string, unknown>
        | undefined,
    all: (sql: string, ...parameters: unknown[]) =>
      connection.prepare(sql).all(...(parameters as never[])) as Record<string, unknown>[],
  };
}

/**
 * The read-only dispatch the production child and the records test-support mirror share, so
 * their read paths cannot diverge: findByOperation for operation scans, lookup otherwise.
 */
export function dispatchJournalSqliteRead(
  connection: JournalSqliteStatementConnection,
  kind: string,
  namespaceId: string,
  ownerFence: string,
  value: unknown,
  now: number
): unknown {
  const reader = journalSqliteStatementReader(connection);
  if (kind === 'findByOperation')
    return findJournalSqliteRecordsByOperation(
      reader,
      namespaceId,
      ownerFence,
      value as Parameters<typeof findJournalSqliteRecordsByOperation>[3],
      now
    );
  return lookupJournalSqliteRecord(
    reader,
    namespaceId,
    ownerFence,
    value as Parameters<typeof lookupJournalSqliteRecord>[3],
    now
  );
}

export type JournalSqliteOpenOutcome =
  | { readonly kind: 'opened'; readonly ownerFence: string }
  | {
      readonly kind: 'refused';
      readonly reason: 'ownership' | 'configuration' | 'capacity' | 'expired';
    };

interface NamespaceRow {
  readonly descriptor: RawJournalNamespace;
  readonly activeFence: string | undefined;
  readonly fenceSerial: number;
  readonly reservedBytes: number;
  readonly clockHighWater: number;
}

const row = (reader: JournalSqliteReader, namespaceId: string): NamespaceRow | undefined => {
  const found = reader.get(
    'SELECT descriptor, active_fence, fence_serial, reserved_bytes, clock_high_water FROM journal_namespace WHERE namespace_id = ?',
    namespaceId
  );
  if (!found) return undefined;
  return {
    descriptor: JSON.parse(found.descriptor as string) as RawJournalNamespace,
    activeFence: (found.active_fence as string | null) ?? undefined,
    fenceSerial: found.fence_serial as number,
    reservedBytes: found.reserved_bytes as number,
    clockHighWater: found.clock_high_water as number,
  };
};

const recordKey = (key: JournalKey): string => canonicalJson(key);

/**
 * A namespace is retirable once released, past its retention horizon (judged by
 * the larger of the caller's clock, bound as ?1, and its persisted high-water) and
 * settled: no record without a terminal fact. An in-doubt record keeps its namespace
 * (and its capacity) until reconciliation. NULL-safe: a row without a numeric
 * retainUntil is never retirable and always counts.
 */
const RETIRABLE = `(active_fence IS NULL
  AND coalesce(max(?1, clock_high_water) > json_extract(descriptor, '$.retainUntil'), 0)
  AND NOT EXISTS (SELECT 1 FROM journal_record r
    WHERE r.namespace_id = journal_namespace.namespace_id
      AND json_extract(r.record, '$.terminal') IS NULL))`;

/**
 * Retire retirable namespaces inside the caller's commit unit: delete their records,
 * zero the reservation and raise the high-water to the effective time. The row stays
 * as a tombstone that can never reopen: forward, max(now, high-water) is past
 * retainUntil (`expired`); after a clock rollback, now is below the high-water
 * (`configuration`); any other descriptor is `configuration`. Purged operation IDs
 * are therefore never admitted again. Rows already retired are not rewritten.
 */
function retireJournalSqliteNamespaces(transaction: JournalSqliteTransaction, now: number): void {
  transaction.run(
    `DELETE FROM journal_record WHERE namespace_id IN (SELECT namespace_id FROM journal_namespace WHERE ${RETIRABLE})`,
    now
  );
  transaction.run(
    `UPDATE journal_namespace SET reserved_bytes = 0, clock_high_water = max(?1, clock_high_water)
     WHERE ${RETIRABLE}
       AND (reserved_bytes <> 0 OR clock_high_water <= json_extract(descriptor, '$.retainUntil'))`,
    now
  );
}
const same = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

/**
 * Claim or rejoin one namespace. Runs inside a mutate unit: refusals still advance
 * the commit witness because the unit already opened; callers read-check first so the
 * common refused open never reaches storage. The store-wide namespace ceiling is the
 * first inserted namespace's `bounds.maxNamespaces`; later namespaces must repeat it.
 */
export function openJournalSqliteRecords(
  transaction: JournalSqliteTransaction,
  descriptor: RawJournalNamespace,
  now: number,
  /** Wall time for what persists or deletes (high-water, retirement, rollback check). */
  wall: number = now
): JournalSqliteOpenOutcome {
  // Stricter than the memory oracle, which never validates schemaVersion on its new
  // namespace path: unreachable through the port (parseJournalNamespace enforces 1)
  // and the safe direction for a direct caller.
  if (descriptor.schemaVersion !== 1) return { kind: 'refused', reason: 'configuration' };
  ensureJournalSqliteRecordSchema(transaction);
  const state = row(transaction, descriptor.namespaceId);
  if (state) {
    if (!same(state.descriptor, descriptor)) return { kind: 'refused', reason: 'configuration' };
    // Rollback detection: a wall clock below the persisted high-water
    // contradicts stored state and refuses as configuration.
    if (wall < state.clockHighWater) return { kind: 'refused', reason: 'configuration' };
    if (Math.max(now, state.clockHighWater) > state.descriptor.retainUntil)
      return { kind: 'refused', reason: 'expired' };
    if (state.activeFence !== undefined) return { kind: 'refused', reason: 'ownership' };
    const fence = `sqlite-fence-${state.fenceSerial + 1}`;
    transaction.run(
      'UPDATE journal_namespace SET active_fence = ?, fence_serial = ?, clock_high_water = ? WHERE namespace_id = ?',
      fence,
      state.fenceSerial + 1,
      Math.max(wall, state.clockHighWater),
      descriptor.namespaceId
    );
    return { kind: 'opened', ownerFence: fence };
  }
  if (now > descriptor.acceptUntil || now > descriptor.retainUntil)
    return { kind: 'refused', reason: 'expired' };
  const total = transaction.get('SELECT count(*) AS count FROM journal_namespace')?.count;
  if (typeof total !== 'number') return { kind: 'refused', reason: 'capacity' };
  if (total > 0) {
    // Tombstones keep the store-wide ceiling: a later namespace still cannot widen it.
    const mismatch = transaction.get(
      "SELECT count(*) AS count FROM journal_namespace WHERE json_extract(descriptor, '$.bounds.maxNamespaces') <> ?",
      descriptor.bounds.maxNamespaces
    )?.count;
    if (mismatch !== 0) return { kind: 'refused', reason: 'configuration' };
    // Retention reclaims capacity only at the point of need: settled, released,
    // expired namespaces are retired when the ceiling would otherwise refuse.
    if (total >= descriptor.bounds.maxNamespaces) {
      retireJournalSqliteNamespaces(transaction, wall);
      const live = transaction.get(
        `SELECT count(*) AS count FROM journal_namespace WHERE NOT ${RETIRABLE}`,
        wall
      )?.count;
      if (typeof live !== 'number' || live >= descriptor.bounds.maxNamespaces)
        return { kind: 'refused', reason: 'capacity' };
    }
  }
  const fence = 'sqlite-fence-1';
  transaction.run(
    'INSERT INTO journal_namespace (namespace_id, descriptor, active_fence, fence_serial, reserved_bytes, clock_high_water) VALUES (?, ?, ?, 1, 0, ?)',
    descriptor.namespaceId,
    canonicalJson(descriptor),
    fence,
    wall
  );
  return { kind: 'opened', ownerFence: fence };
}

/** Fence and retention refusal shared by every per-record call. */
function fenceRefusal(
  reader: JournalSqliteReader,
  namespaceId: string,
  ownerFence: string,
  now: number
): 'fenced' | 'expired' | undefined {
  const state = row(reader, namespaceId);
  if (!state || state.activeFence !== ownerFence) return 'fenced';
  if (Math.max(now, state.clockHighWater) > state.descriptor.retainUntil) return 'expired';
  return undefined;
}

function prepareWrite(
  transaction: JournalSqliteTransaction,
  namespaceId: string,
  ownerFence: string,
  now: number,
  wall: number
):
  | { state: NamespaceRow }
  | { readonly kind: 'definitely_not_written'; readonly reason: 'fenced' | 'expired' } {
  const refused = fenceRefusal(transaction, namespaceId, ownerFence, now);
  if (refused) return { kind: 'definitely_not_written', reason: refused };
  const state = row(transaction, namespaceId);
  if (!state) return { kind: 'definitely_not_written', reason: 'fenced' };
  transaction.run(
    'UPDATE journal_namespace SET clock_high_water = ? WHERE namespace_id = ?',
    Math.max(wall, state.clockHighWater),
    namespaceId
  );
  return { state };
}

/** Record outcomes use the storage-neutral shapes; stamping belongs to the adapter layer. */
export type JournalSqliteMutationOutcome =
  | {
      readonly kind: 'acknowledged';
      readonly disposition: 'applied' | 'already_applied' | 'existing';
      readonly record: JournalRecord;
    }
  | {
      readonly kind: 'definitely_not_written';
      readonly reason: 'fenced' | 'expired' | 'admission_expired' | 'capacity';
    }
  | {
      readonly kind: 'conflict';
      readonly reason:
        | 'identity'
        | 'revision'
        | 'missing_intent'
        | 'operation_terminal'
        | 'terminal_facts';
    };

const storedRecord = (stored: Record<string, unknown>): JournalRecord =>
  JSON.parse(stored.record as string) as JournalRecord;

export function reserveJournalSqliteIntent(
  transaction: JournalSqliteTransaction,
  namespaceId: string,
  ownerFence: string,
  transition: JournalTransition,
  now: number,
  wall: number = now
): JournalSqliteMutationOutcome {
  const ready = prepareWrite(transaction, namespaceId, ownerFence, now, wall);
  if ('kind' in ready) return ready;
  const key = recordKey(transition.identity.key);
  const current = transaction.get(
    'SELECT record, identity FROM journal_record WHERE namespace_id = ? AND record_key = ?',
    namespaceId,
    key
  );
  if (current) {
    if (current.identity !== canonicalJson(transition.identity))
      return { kind: 'conflict', reason: 'identity' };
    // An acknowledged resume commits, so it advances the high-water exactly
    // like a fresh admission (memory-oracle parity).
    transaction.run(
      'UPDATE journal_namespace SET clock_high_water = ? WHERE namespace_id = ?',
      Math.max(wall, ready.state.clockHighWater),
      namespaceId
    );
    return {
      kind: 'acknowledged',
      disposition: 'existing',
      record: storedRecord(current),
    };
  }
  if (transition.expectedRevision !== 0) return { kind: 'conflict', reason: 'revision' };
  if (Math.max(now, ready.state.clockHighWater) > ready.state.descriptor.acceptUntil)
    return { kind: 'definitely_not_written', reason: 'admission_expired' };
  const count = transaction.get(
    'SELECT count(*) AS count FROM journal_record WHERE namespace_id = ?',
    namespaceId
  )?.count;
  if (typeof count !== 'number' || count >= ready.state.descriptor.bounds.maxRecords)
    return { kind: 'definitely_not_written', reason: 'capacity' };
  const record: JournalRecord = {
    schemaVersion: 1,
    namespaceId,
    identity: transition.identity,
    revision: 1,
    intent: true,
    dispatched: false,
  };
  transaction.run(
    'INSERT INTO journal_record (namespace_id, record_key, identity, revision, record) VALUES (?, ?, ?, 1, ?)',
    namespaceId,
    key,
    canonicalJson(transition.identity),
    canonicalJson(record)
  );
  // Intent admission reserves the maximum configured terminal-record slot.
  // Diagnostic accounting only: it always equals records × maxRecordBytes
  // (maxRecords is the enforced bound) and retirement zeroes it.
  transaction.run(
    'UPDATE journal_namespace SET reserved_bytes = reserved_bytes + ? WHERE namespace_id = ?',
    ready.state.descriptor.bounds.maxRecordBytes,
    namespaceId
  );
  return { kind: 'acknowledged', disposition: 'applied', record };
}

export function markJournalSqliteDispatch(
  transaction: JournalSqliteTransaction,
  namespaceId: string,
  ownerFence: string,
  transition: JournalTransition,
  now: number,
  wall: number = now
): JournalSqliteMutationOutcome {
  const ready = prepareWrite(transaction, namespaceId, ownerFence, now, wall);
  if ('kind' in ready) return ready;
  const key = recordKey(transition.identity.key);
  const current = transaction.get(
    'SELECT record, identity FROM journal_record WHERE namespace_id = ? AND record_key = ?',
    namespaceId,
    key
  );
  if (!current) return { kind: 'conflict', reason: 'missing_intent' };
  const record = storedRecord(current);
  if (current.identity !== canonicalJson(transition.identity))
    return { kind: 'conflict', reason: 'identity' };
  if (record.terminal) return { kind: 'conflict', reason: 'operation_terminal' };
  if (record.revision === 2 && record.dispatched && transition.expectedRevision === 1)
    return { kind: 'acknowledged', disposition: 'already_applied', record };
  if (record.revision !== 1 || record.dispatched || transition.expectedRevision !== 1)
    return { kind: 'conflict', reason: 'revision' };
  const updated: JournalRecord = { ...record, revision: 2, dispatched: true };
  transaction.run(
    'UPDATE journal_record SET revision = 2, record = ? WHERE namespace_id = ? AND record_key = ?',
    canonicalJson(updated),
    namespaceId,
    key
  );
  return { kind: 'acknowledged', disposition: 'applied', record: updated };
}

export function commitJournalSqliteTerminal(
  transaction: JournalSqliteTransaction,
  namespaceId: string,
  ownerFence: string,
  transition: JournalTerminalTransition,
  now: number,
  wall: number = now
): JournalSqliteMutationOutcome {
  const ready = prepareWrite(transaction, namespaceId, ownerFence, now, wall);
  if ('kind' in ready) return ready;
  const key = recordKey(transition.identity.key);
  const current = transaction.get(
    'SELECT record, identity FROM journal_record WHERE namespace_id = ? AND record_key = ?',
    namespaceId,
    key
  );
  if (!current) return { kind: 'conflict', reason: 'missing_intent' };
  const record = storedRecord(current);
  if (current.identity !== canonicalJson(transition.identity))
    return { kind: 'conflict', reason: 'identity' };
  if (record.terminal) {
    const predecessorRevision = record.dispatched ? 2 : 1;
    if (transition.expectedRevision !== predecessorRevision)
      return { kind: 'conflict', reason: 'revision' };
    if (record.dispatched !== transition.dispatched || !same(record.terminal, transition.terminal))
      return { kind: 'conflict', reason: 'terminal_facts' };
    return { kind: 'acknowledged', disposition: 'already_applied', record };
  }
  const legalPredispatch =
    !transition.dispatched &&
    transition.expectedRevision === 1 &&
    record.revision === 1 &&
    !record.dispatched &&
    transition.terminal.status === 'failed';
  const legalDispatched =
    transition.dispatched &&
    transition.expectedRevision === 2 &&
    record.revision === 2 &&
    record.dispatched;
  if (!legalPredispatch && !legalDispatched) return { kind: 'conflict', reason: 'revision' };
  const updated: JournalRecord = {
    ...record,
    revision: transition.dispatched ? 3 : 2,
    dispatched: transition.dispatched,
    terminal: transition.terminal,
  };
  transaction.run(
    'UPDATE journal_record SET revision = ?, record = ? WHERE namespace_id = ? AND record_key = ?',
    updated.revision,
    canonicalJson(updated),
    namespaceId,
    key
  );
  return { kind: 'acknowledged', disposition: 'applied', record: updated };
}

export type JournalSqliteLookupOutcome =
  | { readonly kind: 'found'; readonly record: JournalRecord }
  | { readonly kind: 'scoped_absent' }
  | { readonly kind: 'definitely_not_read'; readonly reason: 'fenced' | 'expired' };

/** Reads through the caller's connection; computes effective time without persisting it. */
export function lookupJournalSqliteRecord(
  reader: JournalSqliteReader,
  namespaceId: string,
  ownerFence: string,
  key: JournalKey,
  now: number
): JournalSqliteLookupOutcome {
  const refused = fenceRefusal(reader, namespaceId, ownerFence, now);
  if (refused) return { kind: 'definitely_not_read', reason: refused };
  const current = reader.get(
    'SELECT record FROM journal_record WHERE namespace_id = ? AND record_key = ?',
    namespaceId,
    recordKey(key)
  );
  return current ? { kind: 'found', record: storedRecord(current) } : { kind: 'scoped_absent' };
}

export type JournalSqliteFindOutcome =
  | {
      readonly kind: 'found';
      readonly records: readonly JournalRecord[];
      readonly truncated: boolean;
    }
  | { readonly kind: 'definitely_not_read'; readonly reason: 'fenced' | 'expired' };

/**
 * J3a: every record of one tenant's operation ID in the namespace, in insertion order, at most
 * `limit` (+1 read only to report truncation). A bounded scan over the stored identity: the
 * tenant and operation ID live inside the identity JSON, and an index would be new DDL, which
 * is a new formatVersion. The namespace is capped at maxRecords, which bounds the scan.
 */
export function findJournalSqliteRecordsByOperation(
  reader: JournalSqliteReader & {
    all(sql: string, ...parameters: unknown[]): Record<string, unknown>[];
  },
  namespaceId: string,
  ownerFence: string,
  query: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly limit: number;
    readonly actionableOnly?: boolean;
  },
  now: number
): JournalSqliteFindOutcome {
  const refused = fenceRefusal(reader, namespaceId, ownerFence, now);
  if (refused) return { kind: 'definitely_not_read', reason: refused };
  const rows = reader.all(
    `SELECT record FROM journal_record
     WHERE namespace_id = ?
       AND json_extract(identity, '$.key.tenantId') = ?
       AND json_extract(identity, '$.key.operationId') = ?
       ${query.actionableOnly === true ? "AND json_extract(record, '$.terminal') IS NULL" : ''}
     ORDER BY rowid LIMIT ?`,
    namespaceId,
    query.tenantId,
    query.operationId,
    query.limit + 1
  );
  return {
    kind: 'found',
    records: rows.slice(0, query.limit).map(storedRecord),
    truncated: rows.length > query.limit,
  };
}

/** Releases the fence; idempotent for an already-stolen or cleared fence. */
export function closeJournalSqliteNamespace(
  transaction: JournalSqliteTransaction,
  namespaceId: string,
  ownerFence: string
): void {
  transaction.run(
    'UPDATE journal_namespace SET active_fence = NULL WHERE namespace_id = ? AND active_fence = ?',
    namespaceId,
    ownerFence
  );
}

/** Test/observation helper: the complete live namespace snapshot over a plain reader. */
export function observeJournalSqliteNamespace(
  reader: JournalSqliteReader & {
    all(sql: string, ...parameters: unknown[]): Record<string, unknown>[];
  },
  namespaceId: string
):
  | {
      readonly descriptor: RawJournalNamespace;
      readonly activeFence?: string;
      readonly records: readonly JournalRecord[];
      readonly reservedBytes: number;
    }
  | undefined {
  const state = row(reader, namespaceId);
  if (!state) return undefined;
  const records = reader
    .all('SELECT record FROM journal_record WHERE namespace_id = ? ORDER BY rowid', namespaceId)
    .map((found) => JSON.parse(found.record as string) as JournalRecord);
  return {
    descriptor: state.descriptor,
    ...(state.activeFence !== undefined ? { activeFence: state.activeFence } : {}),
    records,
    reservedBytes: state.reservedBytes,
  };
}
