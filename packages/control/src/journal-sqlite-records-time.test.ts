/**
 * T5 J-c: the record layer takes two times. Checks (fencing, admission, retention) use the
 * effective time; everything that persists or deletes (the high-water, retirement, the reopen
 * rollback check) uses the wall reading, so no persisted value derives from a monotonic
 * projection and restart behaviour is unchanged.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  ensureJournalSqliteRecordSchema,
  openJournalSqliteRecords,
  reserveJournalSqliteIntent,
} from './journal-sqlite-records.js';
import type { JournalSqliteTransaction } from './journal-sqlite-store.js';
import type { JournalTransition, RawJournalNamespace } from './journal-types.js';

const descriptor: RawJournalNamespace = {
  schemaVersion: 1,
  namespaceId: 'ns-time',
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
    timeoutMs: 1_000,
  },
};

function store() {
  const connection = new DatabaseSync(':memory:');
  const tx: JournalSqliteTransaction = {
    exec: (sql: string) => connection.exec(sql),
    run: (sql: string, ...parameters: never[]) => connection.prepare(sql).run(...parameters),
    get: (sql: string, ...parameters: never[]) =>
      connection.prepare(sql).get(...parameters) as Record<string, unknown> | undefined,
  };
  ensureJournalSqliteRecordSchema(tx);
  const highWater = () =>
    tx.get(
      'SELECT clock_high_water AS hw FROM journal_namespace WHERE namespace_id = ?',
      'ns-time' as never
    )?.hw;
  const release = () => tx.run('UPDATE journal_namespace SET active_fence = NULL');
  return { tx, highWater, release };
}

describe('journal record time: checks vs persistence (T5 J-c)', () => {
  it('persists the wall reading as the high-water, never the effective time', () => {
    const s = store();
    expect(openJournalSqliteRecords(s.tx, descriptor, 1_500, 1_200)).toMatchObject({
      kind: 'opened',
    });
    expect(s.highWater()).toBe(1_200);
  });

  it('judges retention with the effective time (stricter), so an effective time past the horizon expires', () => {
    const s = store();
    openJournalSqliteRecords(s.tx, descriptor, 1_000, 1_000);
    s.release();
    // Effective 5_100 is past retainUntil although the wall (4_900) is not.
    expect(openJournalSqliteRecords(s.tx, descriptor, 5_100, 4_900)).toMatchObject({
      kind: 'refused',
      reason: 'expired',
    });
  });

  it('detects a reopen rollback with the wall reading against the persisted high-water', () => {
    const s = store();
    openJournalSqliteRecords(s.tx, descriptor, 1_500, 1_500);
    s.release();
    expect(openJournalSqliteRecords(s.tx, descriptor, 1_600, 1_400)).toMatchObject({
      kind: 'refused',
      reason: 'configuration',
    });
  });

  it('a single time argument keeps the previous meaning (both roles)', () => {
    const s = store();
    expect(openJournalSqliteRecords(s.tx, descriptor, 1_300)).toMatchObject({ kind: 'opened' });
    expect(s.highWater()).toBe(1_300);
  });

  const transition: JournalTransition = {
    identity: {
      key: {
        serviceGeneration: 's'.repeat(22),
        tenantId: 'tenant-a',
        sessionIncarnation: 'i'.repeat(22),
        epoch: 1,
        operationId: 'op-time',
      },
      actor: 'agent',
      fingerprint: { version: 1, keyId: 'key-1', digest: 'd'.repeat(64) },
    },
    expectedRevision: 0,
  };

  it('a reopen persists the wall reading, not the effective time', () => {
    const s = store();
    openJournalSqliteRecords(s.tx, descriptor, 1_000, 1_000);
    s.release();
    expect(openJournalSqliteRecords(s.tx, descriptor, 1_600, 1_200)).toMatchObject({
      kind: 'opened',
    });
    expect(s.highWater()).toBe(1_200);
  });

  it('a mutation (prepareWrite) and a resumed intent persist the wall reading', () => {
    const s = store();
    const opened = openJournalSqliteRecords(s.tx, descriptor, 1_000, 1_000);
    if (opened.kind !== 'opened') throw new Error('not opened');
    expect(
      reserveJournalSqliteIntent(s.tx, 'ns-time', opened.ownerFence, transition, 1_500, 1_100)
    ).toMatchObject({ kind: 'acknowledged', disposition: 'applied' });
    expect(s.highWater()).toBe(1_100);
    expect(
      reserveJournalSqliteIntent(s.tx, 'ns-time', opened.ownerFence, transition, 1_700, 1_300)
    ).toMatchObject({ kind: 'acknowledged', disposition: 'existing' });
    expect(s.highWater()).toBe(1_300);
  });

  it('retirement judges the wall reading: an effective time past retention never deletes', () => {
    const s = store();
    for (const namespaceId of ['ns-time', 'ns-two']) {
      openJournalSqliteRecords(s.tx, { ...descriptor, namespaceId }, 1_000, 1_000);
      s.release();
    }
    // At capacity (2): opening a third namespace would retire settled, expired ones. Effective
    // 5_100 is past their retainUntil (5_000) but the wall (4_900) is not, so nothing retires.
    const third = {
      ...descriptor,
      namespaceId: 'ns-three',
      acceptUntil: 9_000,
      retainUntil: 9_000,
    };
    expect(openJournalSqliteRecords(s.tx, third, 5_100, 4_900)).toMatchObject({
      kind: 'refused',
      reason: 'capacity',
    });
    expect(s.highWater()).toBe(1_000);
  });
});
