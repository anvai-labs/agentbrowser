import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  classifyJournalRecord,
  JournalLookupResultSchema,
  JournalStatusSchema,
} from './journal-lookup.js';

describe('classifyJournalRecord (J3b)', () => {
  it.each([
    [{ revision: 1, dispatched: false }, 'undispatched', true],
    [{ revision: 2, dispatched: true }, 'in_doubt', true],
    [
      { revision: 2, dispatched: false, terminal: { status: 'failed' } },
      'failed_before_dispatch',
      false,
    ],
    [{ revision: 3, dispatched: true, terminal: { status: 'completed' } }, 'completed', false],
    [{ revision: 3, dispatched: true, terminal: { status: 'failed' } }, 'failed', false],
    [
      { revision: 3, dispatched: true, terminal: { status: 'outcome_unknown' } },
      'settled_unknown',
      false,
    ],
  ])('classifies %j as %s (actionable %s)', (record, classification, actionable) => {
    expect(classifyJournalRecord(record as never)).toEqual({ classification, actionable });
  });
  it.each([
    { revision: 2, dispatched: true, terminal: { status: 'failed' } },
    { revision: 3, dispatched: true, terminal: { status: 'weird' } },
    { revision: 3, dispatched: true },
    { revision: 4, dispatched: true, terminal: { status: 'completed' } },
  ])('refuses an illegal state: %j', (record) => {
    expect(() => classifyJournalRecord(record as never)).toThrow();
  });
});

it('validates lookup results and status strictly (J3b)', () => {
  const record = {
    namespace: 'agentbrowser',
    classification: 'in_doubt',
    actionable: true,
    application: { adapter: 'a', resource: 'r', bindingGeneration: 'g' },
    session: { sessionIncarnation: 'i'.repeat(22), epoch: 1 },
  };
  expect(
    Value.Check(JournalLookupResultSchema, {
      schemaVersion: 1,
      operationId: 'op-1',
      absent: false,
      truncated: false,
      records: [record],
    })
  ).toBe(true);
  expect(
    Value.Check(JournalLookupResultSchema, {
      schemaVersion: 1,
      operationId: 'op-1',
      absent: false,
      truncated: false,
      records: [{ ...record, fingerprint: 'leak' }],
    })
  ).toBe(false);
  expect(
    Value.Check(JournalStatusSchema, {
      schemaVersion: 1,
      configured: true,
      namespace: 'agentbrowser',
      health: 'open',
      acceptUntil: '2099-01-01T00:00:00.000Z',
      retainUntil: '2099-01-31T00:00:00.000Z',
      runtime: { platform: 'linux', node: '24.21.0', qualified: true },
      recoveryQualified: true,
    })
  ).toBe(true);
  expect(
    Value.Check(JournalStatusSchema, {
      schemaVersion: 1,
      configured: false,
      runtime: { platform: 'linux', node: '24.21.0', qualified: true },
      recoveryQualified: false,
      surprise: true,
    })
  ).toBe(false);
});
