import { createHmac } from 'node:crypto';
import { canonicalJson } from '@agentbrowser/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  JournalIntent,
  JournalNamespace,
  JournalRecord,
  RawOperationJournalHandle,
} from './journal-types.js';
import { openOperationJournal } from './operation-journal.js';

const key = Buffer.alloc(32, 7);
const namespace = (): JournalNamespace => ({
  schemaVersion: 1,
  namespaceId: 'deployment-a',
  fingerprintVersion: 1,
  fingerprintKeyId: 'key-1',
  restoreGeneration: 'operator-generation-1',
  acceptUntil: 10_000,
  retainUntil: 20_000,
  maxFinalizationMs: 1000,
  bounds: {
    maxRecordBytes: 16384,
    maxRecords: 10,
    maxNamespaces: 2,
    maxInFlight: 2,
    timeoutMs: 50,
  },
});
const intent = (): JournalIntent => ({
  key: {
    serviceGeneration: 's'.repeat(22),
    tenantId: 'tenant-a',
    sessionIncarnation: 'i'.repeat(22),
    epoch: 1,
    operationId: 'op-1',
  },
  actor: 'operator-a',
  liveFingerprint: { algorithm: 'rest-json-v1', digest: 'PRIVATE-LIVE-DIGEST' },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const ns = namespace();
  const stamp = (value: unknown) => ({ namespaceId: ns.namespaceId, ownerFence: 'fence-1', value });
  const record = (identity: unknown): JournalRecord =>
    ({
      schemaVersion: 1,
      namespaceId: ns.namespaceId,
      identity,
      revision: 1,
      intent: true,
      dispatched: false,
    }) as JournalRecord;
  const raw = {
    reserveIntent: vi.fn(async (request) =>
      stamp({
        kind: 'acknowledged',
        disposition: 'applied',
        record: record(request.value.identity),
      })
    ),
    markDispatch: vi.fn(async () => stamp({ kind: 'conflict', reason: 'missing_intent' })),
    commitTerminal: vi.fn(async () => stamp({ kind: 'conflict', reason: 'missing_intent' })),
    lookup: vi.fn(async () => stamp({ kind: 'scoped_absent' })),
    close: vi.fn(async () => ({ kind: 'closed' })),
  };
  const adapter = {
    open: vi.fn(async (openedNamespace) => ({
      kind: 'opened',
      namespace: openedNamespace,
      ownerFence: 'fence-1',
      handle: raw as RawOperationJournalHandle,
    })),
  };
  const open = async () => {
    const result = await openOperationJournal(adapter, ns, key);
    expect(result.kind).toBe('opened');
    if (result.kind !== 'opened') throw new Error('fixture open');
    return result.journal;
  };
  return { ns, stamp, record, raw, adapter, open };
}

afterEach(() => vi.useRealTimers());

describe('journal call settlement', () => {
  it('publishes quarantine before settlement when storage responds during timeout abort', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const journal = await f.open();
    f.raw.lookup.mockImplementationOnce(
      (_request: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(f.stamp({ kind: 'scoped_absent' })), {
            once: true,
          });
        }) as never
    );
    const call = journal.lookup(intent().key);
    const observation = call.settled.then(() => ({
      health: journal.health,
      pending: journal.pending,
    }));
    await vi.advanceTimersByTimeAsync(51);
    expect(await call).toEqual({ kind: 'uncertain', reason: 'wait_expired' });
    expect(await observation).toEqual({ health: 'quarantined', pending: 0 });
  });

  it.each(['reserveIntent', 'markDispatch', 'commitTerminal', 'lookup'] as const)(
    '%s retains its own settlement through timeout and releases it after validation',
    async (method) => {
      vi.useFakeTimers();
      const f = fixture();
      const journal = await f.open();
      const reserved = await journal.reserveIntent(intent());
      if (reserved.kind !== 'acknowledged') throw new Error('fixture intent');
      const delayed = deferred<unknown>();
      f.raw[method].mockImplementationOnce(() => delayed.promise as never);
      const transition = { identity: reserved.record.identity, expectedRevision: 1 };
      const call =
        method === 'reserveIntent'
          ? journal.reserveIntent(intent())
          : method === 'markDispatch'
            ? journal.markDispatch(transition)
            : method === 'commitTerminal'
              ? journal.commitTerminal({
                  ...transition,
                  dispatched: false,
                  terminal: { status: 'failed', evidenceRefIds: [] },
                })
              : journal.lookup(intent().key);
      expect(call.settled).toBeInstanceOf(Promise);
      expect(Object.getOwnPropertyDescriptor(call, 'settled')?.writable).toBe(false);
      let drained = false;
      void call.settled.then(() => {
        expect(journal.pending).toBe(0);
        expect(journal.health).toBe('poisoned');
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(51);
      expect(await call).toEqual({ kind: 'uncertain', reason: 'wait_expired' });
      expect(drained).toBe(false);
      expect(journal.pending).toBe(1);
      // Raw settlement alone is insufficient: validate and poison before notifying the owner.
      delayed.resolve({ private: 'invalid acknowledgment' });
      expect(await call.settled).toBeUndefined();
      expect(drained).toBe(true);
      expect(await call).toEqual({ kind: 'uncertain', reason: 'wait_expired' });
    }
  );

  it('does not wait for a different call or restore health after a late valid ACK', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const journal = await f.open();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    f.raw.lookup.mockImplementationOnce(() => first.promise as never);
    f.raw.lookup.mockImplementationOnce(() => second.promise as never);
    const a = journal.lookup(intent().key);
    const b = journal.lookup({ ...intent().key, operationId: 'op-2' });
    expect(a.settled).toBeInstanceOf(Promise);
    expect(b.settled).toBeInstanceOf(Promise);
    let bSettled = false;
    void b.settled.then(() => {
      bSettled = true;
    });
    await vi.advanceTimersByTimeAsync(51);
    first.resolve(f.stamp({ kind: 'scoped_absent' }));
    await a.settled;
    expect(journal.pending).toBe(1);
    expect(bSettled).toBe(false);
    expect(journal.health).toBe('quarantined');
    second.reject(new Error('PRIVATE storage failure'));
    expect(await b.settled).toBeUndefined();
    expect(journal.pending).toBe(0);
    expect(await b).toEqual({ kind: 'uncertain', reason: 'wait_expired' });
  });

  it('settles pre-I/O refusals without invoking the adapter', async () => {
    const f = fixture();
    const journal = await f.open();
    const abort = new AbortController();
    abort.abort();
    const calls = [
      journal.reserveIntent({ ...intent(), actor: '' }),
      journal.markDispatch({} as never),
      journal.commitTerminal({} as never),
      journal.lookup({} as never),
      journal.reserveIntent(intent(), abort.signal),
    ];
    for (const call of calls) {
      expect(call.settled).toBeInstanceOf(Promise);
      expect(await call.settled).toBeUndefined();
      expect((await call).kind).toMatch(/^definitely_not_/);
    }
    expect(journal.pending).toBe(0);
    expect(f.raw.reserveIntent).not.toHaveBeenCalled();
    expect(f.raw.markDispatch).not.toHaveBeenCalled();
    expect(f.raw.commitTerminal).not.toHaveBeenCalled();
    expect(f.raw.lookup).not.toHaveBeenCalled();
  });

  it('keeps cancellation and close wait expiration separate from actual settlement', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const journal = await f.open();
    const delayed = deferred<unknown>();
    f.raw.reserveIntent.mockImplementationOnce(() => delayed.promise as never);
    const abort = new AbortController();
    const call = journal.reserveIntent(intent(), abort.signal);
    expect(call.settled).toBeInstanceOf(Promise);
    let settled = false;
    void call.settled.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    expect(await call).toEqual({ kind: 'uncertain', reason: 'wait_expired' });
    const closing = journal.close();
    await vi.advanceTimersByTimeAsync(51);
    expect(await closing).toEqual({ kind: 'uncertain', reason: 'wait_expired' });
    expect(settled).toBe(false);
    expect(f.raw.close).not.toHaveBeenCalled();
    delayed.reject(new Error('PRIVATE'));
    await call.settled;
    await vi.advanceTimersByTimeAsync(0);
    expect(journal.pending).toBe(0);
    expect(f.raw.close).toHaveBeenCalledTimes(1);
  });

  it('settles capacity and queued cancellation refusals without draining another call', async () => {
    const f = fixture();
    f.ns.bounds.maxInFlight = 1;
    const journal = await f.open();
    const abort = new AbortController();
    const queued = journal.lookup(intent().key, abort.signal);
    const refused = journal.reserveIntent(intent());
    abort.abort();
    expect(await refused.settled).toBeUndefined();
    expect(await refused).toEqual({ kind: 'definitely_not_written', reason: 'capacity' });
    await queued.settled;
    expect(await queued).toEqual({ kind: 'definitely_not_read', reason: 'aborted' });
    expect(journal.pending).toBe(0);
    expect(f.raw.lookup).not.toHaveBeenCalled();
    expect(f.raw.reserveIntent).not.toHaveBeenCalled();
  });

  it.each(['success', 'throw'] as const)('settles immediate raw %s after cleanup', async (kind) => {
    const f = fixture();
    const journal = await f.open();
    if (kind === 'throw')
      f.raw.reserveIntent.mockImplementationOnce(() => {
        throw new Error('PRIVATE');
      });
    const call = journal.reserveIntent(intent());
    await call.settled;
    expect(journal.pending).toBe(0);
    expect(journal.health).toBe(kind === 'success' ? 'open' : 'quarantined');
    expect((await call).kind).toBe(kind === 'success' ? 'acknowledged' : 'uncertain');
  });
});

describe('bounded journal facade', () => {
  it('binds the namespace to the actual key material without sending the key to storage', async () => {
    const f = fixture();
    await f.open();
    const opened = f.adapter.open.mock.calls[0]?.[0];
    const expected = createHmac('sha256', key)
      .update('agentbrowser:operation-journal:key-check:v1\0')
      .update(canonicalJson({ namespaceId: f.ns.namespaceId, keyId: f.ns.fingerprintKeyId }))
      .digest('hex');
    expect(opened.fingerprintKeyCheck).toBe(expected);
    expect(JSON.stringify(opened)).not.toContain(key.toString('hex'));
  });

  it('stores a domain-separated keyed fingerprint, snapshots identity and freezes returned facts', async () => {
    const f = fixture();
    const journal = await f.open();
    const input = intent();
    const result = await journal.reserveIntent(input);
    expect(result.kind).toBe('acknowledged');
    if (result.kind !== 'acknowledged') throw new Error();
    const { liveFingerprint, ...identity } = input;
    const digest = createHmac('sha256', key)
      .update('agentbrowser:operation-journal:fingerprint:v1\0')
      .update(
        canonicalJson({
          namespaceId: f.ns.namespaceId,
          keyId: f.ns.fingerprintKeyId,
          ...identity,
          liveFingerprint,
        })
      )
      .digest('hex');
    expect(result.record.identity.fingerprint).toEqual({ version: 1, keyId: 'key-1', digest });
    expect(JSON.stringify(f.raw.reserveIntent.mock.calls)).not.toContain('PRIVATE-LIVE-DIGEST');
    expect(Object.isFrozen(result.record.identity.key)).toBe(true);
    expect(Object.isFrozen(journal.namespace.bounds)).toBe(true);
    expect(f.raw.reserveIntent.mock.calls[0]?.[0].value.expectedRevision).toBe(0);
  });

  it.each([
    'accessor',
    'symbol',
    'hidden',
    'prototype',
    'undefined',
    'infinite',
    'oversize',
  ] as const)(
    'rejects %s input before raw I/O without exposing private diagnostics',
    async (kind) => {
      const f = fixture();
      const journal = await f.open();
      const value = intent() as unknown as Record<string | symbol, unknown>;
      let reads = 0;
      if (kind === 'accessor')
        Object.defineProperty(value, 'actor', {
          enumerable: true,
          get: () => {
            reads++;
            throw new Error('PRIVATE');
          },
        });
      if (kind === 'symbol') value[Symbol('PRIVATE')] = true;
      if (kind === 'hidden') Object.defineProperty(value, 'PRIVATE', { value: true });
      if (kind === 'prototype') Object.setPrototypeOf(value, { PRIVATE: true });
      if (kind === 'undefined') value.actor = undefined;
      if (kind === 'infinite') value.key = { ...intent().key, epoch: Number.POSITIVE_INFINITY };
      if (kind === 'oversize') value.actor = 'PRIVATE'.repeat(10000);
      expect(await journal.reserveIntent(value as unknown as JournalIntent)).toEqual({
        kind: 'definitely_not_written',
        reason: 'invalid_request',
      });
      expect(reads).toBe(0);
      expect(f.raw.reserveIntent).not.toHaveBeenCalled();
    }
  );

  it.each(['namespace', 'fence', 'revision', 'key', 'facts', 'digest'] as const)(
    'poisons on a forged %s ACK, allowing no further I/O',
    async (kind) => {
      const f = fixture();
      const journal = await f.open();
      f.raw.reserveIntent.mockImplementationOnce(async (request) => {
        const record = structuredClone(f.record(request.value.identity));
        const response = f.stamp({ kind: 'acknowledged', disposition: 'applied', record });
        if (kind === 'namespace') response.namespaceId = 'other';
        if (kind === 'fence') response.ownerFence = 'other';
        if (kind === 'revision') Object.assign(record, { revision: 4 });
        if (kind === 'key') Object.assign(record.identity.key, { tenantId: 'other' });
        if (kind === 'facts') Object.assign(record, { intent: false });
        if (kind === 'digest')
          Object.assign(record.identity.fingerprint, { digest: 'a'.repeat(64) });
        return response;
      });
      expect(await journal.reserveIntent(intent())).toEqual({
        kind: 'uncertain',
        reason: 'invalid_response',
      });
      expect(journal.health).toBe('poisoned');
      expect(await journal.lookup(intent().key)).toEqual({
        kind: 'definitely_not_read',
        reason: 'poisoned',
      });
      expect(f.raw.lookup).not.toHaveBeenCalled();
    }
  );

  it('retains a timed-out raw task, quarantines writes, and never revives after late ACK', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const journal = await f.open();
    const delayed = deferred<unknown>();
    f.raw.reserveIntent.mockImplementationOnce(() => delayed.promise as never);
    const waiting = journal.reserveIntent(intent());
    await vi.advanceTimersByTimeAsync(51);
    expect(await waiting).toEqual({ kind: 'uncertain', reason: 'wait_expired' });
    expect(journal.pending).toBe(1);
    expect(journal.health).toBe('quarantined');
    expect(await journal.reserveIntent(intent())).toEqual({
      kind: 'definitely_not_written',
      reason: 'quarantined',
    });
    expect(await journal.lookup(intent().key)).toEqual({ kind: 'scoped_absent' });
    const request = f.raw.reserveIntent.mock.calls[0]?.[0];
    delayed.resolve(
      f.stamp({
        kind: 'acknowledged',
        disposition: 'applied',
        record: f.record(request.value.identity),
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(journal.pending).toBe(0);
    expect(journal.health).toBe('quarantined');
    expect(f.raw.reserveIntent).toHaveBeenCalledTimes(1);
  });

  it('poisons on a malformed late ACK even after the waiter timed out', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const journal = await f.open();
    const delayed = deferred<unknown>();
    f.raw.reserveIntent.mockImplementationOnce(() => delayed.promise as never);
    const waiting = journal.reserveIntent(intent());
    await vi.advanceTimersByTimeAsync(51);
    await waiting;
    delayed.resolve({ kind: 'acknowledged', PRIVATE: 'secret' });
    await vi.advanceTimersByTimeAsync(0);
    expect(journal.health).toBe('poisoned');
    expect(journal.pending).toBe(0);
  });

  it('distinguishes pre-abort from abort after invocation and consumes late rejection', async () => {
    const f = fixture();
    const journal = await f.open();
    const abort = new AbortController();
    abort.abort();
    expect(await journal.reserveIntent(intent(), abort.signal)).toEqual({
      kind: 'definitely_not_written',
      reason: 'aborted',
    });
    expect(f.raw.reserveIntent).not.toHaveBeenCalled();
    const late = new AbortController();
    const delayed = deferred<unknown>();
    f.raw.reserveIntent.mockImplementationOnce(() => delayed.promise as never);
    const waiting = journal.reserveIntent(intent(), late.signal);
    await Promise.resolve();
    await Promise.resolve();
    late.abort();
    expect(await waiting).toEqual({ kind: 'uncertain', reason: 'wait_expired' });
    expect(journal.pending).toBe(1);
    delayed.reject(new Error('PRIVATE'));
    await Promise.resolve();
    await Promise.resolve();
    expect(journal.health).toBe('quarantined');
  });

  it('seals close immediately and closes once without releasing unsettled I/O', async () => {
    const f = fixture();
    const journal = await f.open();
    const delayed = deferred<unknown>();
    f.raw.close.mockImplementationOnce(() => delayed.promise as never);
    const closing = journal.close();
    expect(journal.health).toBe('closed');
    expect(await journal.lookup(intent().key)).toEqual({
      kind: 'definitely_not_read',
      reason: 'closed',
    });
    const again = journal.close();
    delayed.resolve({ kind: 'closed' });
    expect(await closing).toEqual({ kind: 'closed' });
    expect(await again).toEqual({ kind: 'closed' });
    expect(f.raw.close).toHaveBeenCalledTimes(1);
  });
});

describe('journal concurrency and acknowledgment boundaries', () => {
  it('refuses saturation before I/O and preserves occupied slots after uncertain waits', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.ns.bounds.maxInFlight = 1;
    const journal = await f.open();
    const delayed = deferred<unknown>();
    f.raw.lookup.mockImplementationOnce(() => delayed.promise as never);
    const waiting = journal.lookup(intent().key);
    expect(await journal.reserveIntent(intent())).toEqual({
      kind: 'definitely_not_written',
      reason: 'capacity',
    });
    expect(f.raw.reserveIntent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(51);
    expect(await waiting).toEqual({ kind: 'uncertain', reason: 'wait_expired' });
    expect(journal.pending).toBe(1);
    expect(await journal.lookup(intent().key)).toEqual({
      kind: 'definitely_not_read',
      reason: 'capacity',
    });
    delayed.resolve(f.stamp({ kind: 'scoped_absent' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(journal.pending).toBe(0);
    expect(journal.health).toBe('quarantined');
  });

  it('waits for actual data I/O before backend close even when both waiters time out', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const journal = await f.open();
    const delayed = deferred<unknown>();
    f.raw.lookup.mockImplementationOnce(() => delayed.promise as never);
    const lookup = journal.lookup(intent().key);
    await vi.advanceTimersByTimeAsync(0);
    const closing = journal.close();
    await vi.advanceTimersByTimeAsync(51);
    expect(await lookup).toEqual({ kind: 'uncertain', reason: 'wait_expired' });
    expect(await closing).toEqual({ kind: 'uncertain', reason: 'wait_expired' });
    expect(f.raw.close).not.toHaveBeenCalled();
    expect(journal.pending).toBe(1);
    delayed.resolve(f.stamp({ kind: 'scoped_absent' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.raw.close).toHaveBeenCalledTimes(1);
    expect(journal.health).toBe('closed');
    expect(await journal.close()).toEqual({ kind: 'uncertain', reason: 'wait_expired' });
  });

  it('captures configuration, method capabilities and caller input before asynchronous work', async () => {
    const f = fixture();
    const journal = await f.open();
    const input = intent();
    f.ns.bounds.maxInFlight = 999;
    f.raw.reserveIntent = vi.fn(async () => {
      throw new Error('PRIVATE');
    });
    const result = journal.reserveIntent(input);
    input.key.tenantId = 'mutated';
    input.liveFingerprint.digest = 'mutated';
    const acknowledged = await result;
    expect(acknowledged.kind).toBe('acknowledged');
    if (acknowledged.kind !== 'acknowledged') throw new Error();
    expect(acknowledged.record.identity.key.tenantId).toBe('tenant-a');
    expect(journal.namespace.bounds.maxInFlight).toBe(2);
    expect(f.raw.reserveIntent).not.toHaveBeenCalled();
  });

  it('refuses canceled or closed queued calls before invoking any raw data method', async () => {
    const f = fixture();
    const journal = await f.open();
    const abort = new AbortController();
    const waiting = journal.reserveIntent(intent(), abort.signal);
    abort.abort();
    expect(await waiting).toEqual({ kind: 'definitely_not_written', reason: 'aborted' });
    const queued = journal.lookup(intent().key);
    const closing = journal.close();
    expect(await queued).toEqual({ kind: 'definitely_not_read', reason: 'closed' });
    expect(await closing).toEqual({ kind: 'closed' });
    expect(f.raw.reserveIntent).not.toHaveBeenCalled();
    expect(f.raw.lookup).not.toHaveBeenCalled();
    expect(journal.pending).toBe(0);
  });

  it.each(['throw', 'reject', 'uncertain'] as const)(
    'quarantines after adapter %s and redacts its diagnostics',
    async (kind) => {
      const f = fixture();
      const journal = await f.open();
      f.raw.reserveIntent.mockImplementationOnce(() => {
        if (kind === 'throw') throw new Error('PRIVATE sql/path/token');
        if (kind === 'reject') return Promise.reject(new Error('PRIVATE sql/path/token'));
        return Promise.resolve(f.stamp({ kind: 'uncertain', reason: 'io' })) as never;
      });
      expect(await journal.reserveIntent(intent())).toEqual({ kind: 'uncertain', reason: 'io' });
      expect(journal.health).toBe('quarantined');
      expect(await journal.reserveIntent(intent())).toEqual({
        kind: 'definitely_not_written',
        reason: 'quarantined',
      });
      expect(f.raw.reserveIntent).toHaveBeenCalledTimes(1);
    }
  );

  it('does not turn a reported positive no-write refusal into uncertainty', async () => {
    const f = fixture();
    const journal = await f.open();
    f.raw.reserveIntent.mockResolvedValueOnce(
      f.stamp({ kind: 'definitely_not_written', reason: 'fenced' }) as never
    );
    expect(await journal.reserveIntent(intent())).toEqual({
      kind: 'definitely_not_written',
      reason: 'fenced',
    });
    expect(journal.health).toBe('poisoned');
    expect(await journal.reserveIntent(intent())).toEqual({
      kind: 'definitely_not_written',
      reason: 'poisoned',
    });
    expect(f.raw.reserveIntent).toHaveBeenCalledTimes(1);
  });

  it('cannot treat a terminal record as a dispatch acknowledgment', async () => {
    const f = fixture();
    const journal = await f.open();
    const reserved = await journal.reserveIntent(intent());
    if (reserved.kind !== 'acknowledged') throw new Error();
    f.raw.markDispatch.mockResolvedValueOnce(
      f.stamp({
        kind: 'acknowledged',
        disposition: 'already_applied',
        record: {
          ...reserved.record,
          revision: 3,
          dispatched: true,
          terminal: { status: 'completed', evidenceRefIds: [] },
        },
      }) as never
    );
    expect(
      await journal.markDispatch({ identity: reserved.record.identity, expectedRevision: 1 })
    ).toEqual({ kind: 'uncertain', reason: 'invalid_response' });
    expect(journal.health).toBe('poisoned');
  });

  it('validates commit facts and rejects a successful acknowledgment of different evidence', async () => {
    const f = fixture();
    const journal = await f.open();
    const reserved = await journal.reserveIntent(intent());
    if (reserved.kind !== 'acknowledged') throw new Error();
    f.raw.commitTerminal.mockResolvedValueOnce(
      f.stamp({
        kind: 'acknowledged',
        disposition: 'applied',
        record: {
          ...reserved.record,
          revision: 3,
          dispatched: true,
          terminal: { status: 'completed', evidenceRefIds: ['wrong-evidence'] },
        },
      }) as never
    );
    expect(
      await journal.commitTerminal({
        identity: reserved.record.identity,
        expectedRevision: 2,
        dispatched: true,
        terminal: { status: 'completed', evidenceRefIds: ['right-evidence'] },
      })
    ).toEqual({ kind: 'uncertain', reason: 'invalid_response' });
  });

  it('rejects a wrong-key lookup rather than disclosing another operation', async () => {
    const f = fixture();
    const journal = await f.open();
    const reserved = await journal.reserveIntent(intent());
    if (reserved.kind !== 'acknowledged') throw new Error();
    f.raw.lookup.mockResolvedValueOnce(
      f.stamp({ kind: 'found', record: reserved.record }) as never
    );
    expect(await journal.lookup({ ...intent().key, operationId: 'other' })).toEqual({
      kind: 'uncertain',
      reason: 'invalid_response',
    });
    expect(journal.health).toBe('poisoned');
  });

  it('validates evidence locators and reserves capacity for maximal terminal growth before intent', async () => {
    const f = fixture();
    f.ns.bounds.maxRecordBytes = 1024;
    const journal = await f.open();
    expect(await journal.reserveIntent(intent())).toEqual({
      kind: 'definitely_not_written',
      reason: 'invalid_request',
    });
    expect(f.raw.reserveIntent).not.toHaveBeenCalled();
    const normal = fixture();
    const other = await normal.open();
    const reserved = await other.reserveIntent(intent());
    if (reserved.kind !== 'acknowledged') throw new Error();
    const terminal = {
      identity: reserved.record.identity,
      expectedRevision: 2,
      dispatched: true,
      terminal: { status: 'completed', evidenceRefIds: new Array(1) },
    };
    expect(await other.commitTerminal(terminal as never)).toEqual({
      kind: 'definitely_not_written',
      reason: 'invalid_request',
    });
    expect(normal.raw.commitTerminal).not.toHaveBeenCalled();
  });

  it('fails closed on substituted namespace metadata and pre-aborted open', async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    expect(await openOperationJournal(f.adapter, f.ns, key, abort.signal)).toEqual({
      kind: 'definitely_not_opened',
      reason: 'aborted',
    });
    expect(f.adapter.open).not.toHaveBeenCalled();
    f.adapter.open.mockImplementationOnce(async (ns) => ({
      kind: 'opened',
      namespace: { ...ns, fingerprintKeyCheck: 'b'.repeat(64) },
      ownerFence: 'fence-1',
      handle: f.raw,
    }));
    expect(await openOperationJournal(f.adapter, f.ns, key)).toEqual({
      kind: 'uncertain',
      reason: 'invalid_response',
    });
  });
});

it('drains an abandoned successful open and closes its exclusive handle exactly once', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const delayed = deferred<unknown>();
  f.adapter.open.mockImplementationOnce(() => delayed.promise as never);
  const opening = openOperationJournal(f.adapter, f.ns, key);
  await vi.advanceTimersByTimeAsync(51);
  expect(await opening).toEqual({ kind: 'uncertain', reason: 'wait_expired' });
  expect(f.raw.close).not.toHaveBeenCalled();
  delayed.resolve({
    kind: 'opened',
    namespace: f.adapter.open.mock.calls[0]?.[0],
    ownerFence: 'fence-1',
    handle: f.raw,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.raw.close).toHaveBeenCalledTimes(1);
  expect(f.raw.reserveIntent).not.toHaveBeenCalled();
});
it.each(['namespace', 'method'] as const)(
  'releases a late opened handle even with invalid %s metadata',
  async (kind) => {
    vi.useFakeTimers();
    const f = fixture();
    const delayed = deferred<unknown>();
    f.adapter.open.mockImplementationOnce(() => delayed.promise as never);
    const opening = openOperationJournal(f.adapter, f.ns, key);
    await vi.advanceTimersByTimeAsync(51);
    await opening;
    const response = {
      kind: 'opened',
      namespace: f.adapter.open.mock.calls[0]?.[0],
      ownerFence: 'fence-1',
      handle: f.raw,
    };
    if (kind === 'namespace') response.namespace = { ...response.namespace, namespaceId: 'wrong' };
    if (kind === 'method') Object.assign(response.handle, { lookup: undefined });
    delayed.resolve(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.raw.close).toHaveBeenCalledTimes(1);
  }
);

it.each(['markDispatch', 'commitTerminal', 'lookup'] as const)(
  'refuses admission-only expiry returned for %s on accepted work',
  async (method) => {
    const f = fixture();
    const journal = await f.open();
    const reserved = await journal.reserveIntent(intent());
    if (reserved.kind !== 'acknowledged') throw new Error();
    f.raw[method].mockResolvedValueOnce(
      f.stamp({
        kind: method === 'lookup' ? 'definitely_not_read' : 'definitely_not_written',
        reason: 'admission_expired',
      }) as never
    );
    const result =
      method === 'lookup'
        ? await journal.lookup(intent().key)
        : method === 'markDispatch'
          ? await journal.markDispatch({ identity: reserved.record.identity, expectedRevision: 1 })
          : await journal.commitTerminal({
              identity: reserved.record.identity,
              expectedRevision: 1,
              dispatched: false,
              terminal: { status: 'failed', evidenceRefIds: [] },
            });
    expect(result).toEqual({ kind: 'uncertain', reason: 'invalid_response' });
    expect(journal.health).toBe('poisoned');
  }
);
