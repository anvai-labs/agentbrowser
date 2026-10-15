/**
 * T5 J3d (D7): history namespaces after rotation, against a real store.
 *
 * A namespace whose accept horizon passed is no longer opened as the current one; listed in
 * AGENTBROWSER_JOURNAL_HISTORY_FILE with every descriptor input and its ORIGINAL key file, it
 * reopens on the same store adapter so its records stay readable (and recoverable) until
 * retainUntil. A wrong entry is reported per namespace, never fatal to the current namespace.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  historyJournalNamespace,
  JournalConfigError,
  journalConfigFromEnvironment,
  journalHistoryFromEnvironment,
  openServiceJournal,
  openServiceJournalSet,
  searchJournalNamespaces,
  serviceJournalHistoryTemplate,
  serviceJournalNamespace,
} from './journal-config.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function layout() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'j3d-'));
  cleanup.push(base);
  mkdirSync(join(base, 'store'), { mode: 0o700 });
  mkdirSync(join(base, 'anchor'), { mode: 0o700 });
  const keyA = join(base, 'key-a');
  const keyB = join(base, 'key-b');
  writeFileSync(keyA, `key-a:${'a1'.repeat(32)}\n`, { mode: 0o600 });
  writeFileSync(keyB, `key-b:${'b2'.repeat(32)}\n`, { mode: 0o600 });
  const historyFile = join(base, 'history.json');
  const env = (namespace: string, keyFile: string, acceptUntil: string) => ({
    AGENTBROWSER_JOURNAL_DIR: join(base, 'store'),
    AGENTBROWSER_JOURNAL_ANCHOR_DIR: join(base, 'anchor'),
    AGENTBROWSER_JOURNAL_KEY_FILE: keyFile,
    AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'generation-1',
    AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: acceptUntil,
    AGENTBROWSER_JOURNAL_NAMESPACE: namespace,
  });
  const writeHistory = (namespaces: unknown[], mode = 0o600) => {
    writeFileSync(historyFile, JSON.stringify({ schemaVersion: 1, namespaces }), { mode });
    chmodSync(historyFile, mode);
  };
  return { base, keyA, keyB, historyFile, env, writeHistory };
}

const intentOf = (operationId: string) => ({
  key: {
    serviceGeneration: 's'.repeat(22),
    tenantId: 'owner',
    sessionIncarnation: 'i'.repeat(22),
    epoch: 1,
    operationId,
  },
  actor: 'operator',
  application: { adapterId: 'a', resourceId: 'r', bindingGeneration: 'g' },
  liveFingerprint: { algorithm: 'application-operation:v1', digest: `d-${operationId}` },
});

describe('journalHistoryFromEnvironment', () => {
  it('is empty when unset, and the template round-trips to the exact original descriptor', async () => {
    const l = layout();
    expect(await journalHistoryFromEnvironment({})).toEqual([]);
    const config = await journalConfigFromEnvironment(
      l.env('ns-a', l.keyA, '2099-01-01T00:00:00Z')
    );
    if (!config) throw new Error('expected configuration');
    const template = serviceJournalHistoryTemplate(config);
    // The template carries no key material — only the place for the key file path.
    expect(JSON.stringify(template)).not.toContain('a1a1');
    l.writeHistory([{ ...template, keyFile: l.keyA }]);
    const [entry] = await journalHistoryFromEnvironment({
      AGENTBROWSER_JOURNAL_HISTORY_FILE: l.historyFile,
    });
    if (!entry) throw new Error('expected an entry');
    expect(historyJournalNamespace(entry)).toEqual(serviceJournalNamespace(config));
  });

  type Prepare = (l: ReturnType<typeof layout>) => { file?: string };
  const refusals: Array<[string, Prepare]> = [
    ['relative path', () => ({ file: 'history.json' })],
    [
      'group-readable file',
      (l) => {
        l.writeHistory([], 0o640);
        return {};
      },
    ],
    [
      'not JSON',
      (l) => {
        writeFileSync(l.historyFile, '{', { mode: 0o600 });
        return {};
      },
    ],
    [
      'unknown entry key',
      (l) => {
        l.writeHistory([{ namespace: 'x', extra: 1 }]);
        return {};
      },
    ],
    [
      'the current namespace listed as history',
      (l) => {
        l.writeHistory([entryFor(l, 'ns-current')]);
        return {};
      },
    ],
    [
      'a duplicate namespace',
      (l) => {
        l.writeHistory([entryFor(l, 'ns-old'), entryFor(l, 'ns-old')]);
        return {};
      },
    ],
    [
      'more than 16 entries',
      (l) => {
        l.writeHistory(Array.from({ length: 17 }, (_, i) => entryFor(l, `ns-${i}`)));
        return {};
      },
    ],
    [
      'a relative key file',
      (l) => {
        l.writeHistory([{ ...entryFor(l, 'ns-old'), keyFile: 'key-a' }]);
        return {};
      },
    ],
    [
      'bounds missing a field',
      (l) => {
        l.writeHistory([{ ...entryFor(l, 'ns-old'), bounds: { maxRecordBytes: 1 } }]);
        return {};
      },
    ],
  ];
  it.each(refusals)('refuses %s', async (_name, prepare) => {
    const l = layout();
    const { file } = prepare(l) as { file?: string };
    const current = await journalConfigFromEnvironment(
      l.env('ns-current', l.keyA, '2099-01-01T00:00:00Z')
    );
    await expect(
      journalHistoryFromEnvironment(
        { AGENTBROWSER_JOURNAL_HISTORY_FILE: file ?? l.historyFile },
        current
      )
    ).rejects.toBeInstanceOf(JournalConfigError);
  });
});

function entryFor(l: ReturnType<typeof layout>, namespace: string, keyFile = l.keyA) {
  return {
    namespace,
    acceptUntil: '2099-01-01T00:00:00Z',
    keyFile,
    restoreGeneration: 'generation-1',
    maxRecords: 10_000,
    retainMs: 30 * 24 * 60 * 60 * 1000,
    finalizationMs: 60_000,
    bounds: { maxRecordBytes: 16_384, maxNamespaces: 64, maxInFlight: 8, timeoutMs: 5_000 },
  };
}

describe('rotation with history (real store)', () => {
  it('a rotated-away namespace reopens from its history entry; its records stay readable', async () => {
    const l = layout();
    // Namespace A: horizon 2 s ahead; one in-doubt record; then the process stops.
    const horizonA = new Date(Date.now() + 2_000).toISOString();
    const configA = await journalConfigFromEnvironment({
      ...l.env('ns-a', l.keyA, horizonA),
      AGENTBROWSER_JOURNAL_INITIALIZE: '1',
    });
    if (!configA) throw new Error('expected configuration');
    const a = await openServiceJournal(configA);
    const reserved = await a.journal.reserveIntent(intentOf('rotated-op'));
    if (reserved.kind !== 'acknowledged') throw new Error('seed failed');
    await a.journal.markDispatch({ identity: reserved.record.identity, expectedRevision: 1 });
    await a.close();
    const template = serviceJournalHistoryTemplate(configA);
    await new Promise((done) => setTimeout(done, 2_300));

    // Rotation: current is B (new name, new key, new horizon); A is listed as history.
    l.writeHistory([{ ...template, keyFile: l.keyA }]);
    const configB = await journalConfigFromEnvironment(
      l.env('ns-b', l.keyB, '2099-01-01T00:00:00Z')
    );
    if (!configB) throw new Error('expected configuration');
    const history = await journalHistoryFromEnvironment(
      { AGENTBROWSER_JOURNAL_HISTORY_FILE: l.historyFile },
      configB
    );
    const set = await openServiceJournalSet(configB, history);
    try {
      expect(set.journal?.namespace.namespaceId).toBe('ns-b');
      expect(set.history).toHaveLength(1);
      const [stateA] = set.history;
      expect(stateA).toMatchObject({
        namespaceId: 'ns-a',
        retainUntil: Date.parse(horizonA) + 30 * 24 * 60 * 60 * 1000,
      });
      expect(stateA?.refusal).toBeUndefined();
      // The rotated namespace still answers for its record (it is past its horizon, so it can
      // never accept a new intent).
      const found = await stateA?.journal?.findByOperation({
        tenantId: 'owner',
        operationId: 'rotated-op',
        limit: 16,
      });
      expect(found).toMatchObject({
        kind: 'found',
        records: [{ namespaceId: 'ns-a', revision: 2, dispatched: true }],
      });
      const admitted = await stateA?.journal?.reserveIntent(intentOf('new-on-old'));
      expect(admitted?.kind).not.toBe('acknowledged');
      // The current namespace is unaffected and does not see A's record.
      expect(
        await set.journal?.findByOperation({
          tenantId: 'owner',
          operationId: 'rotated-op',
          limit: 16,
        })
      ).toMatchObject({ kind: 'found', records: [] });
    } finally {
      await set.close();
    }
  }, 60_000);

  it('a wrong history entry is reported per namespace and never takes the current one down', async () => {
    const l = layout();
    const configA = await journalConfigFromEnvironment({
      ...l.env('ns-a', l.keyA, '2099-01-01T00:00:00Z'),
      AGENTBROWSER_JOURNAL_INITIALIZE: '1',
    });
    if (!configA) throw new Error('expected configuration');
    await (await openServiceJournal(configA)).close();
    // The history entry names A with the WRONG key file: the store refuses it (configuration).
    l.writeHistory([{ ...serviceJournalHistoryTemplate(configA), keyFile: l.keyB }]);
    const configB = await journalConfigFromEnvironment(
      l.env('ns-b', l.keyB, '2099-01-01T00:00:00Z')
    );
    if (!configB) throw new Error('expected configuration');
    const history = await journalHistoryFromEnvironment(
      { AGENTBROWSER_JOURNAL_HISTORY_FILE: l.historyFile },
      configB
    );
    const set = await openServiceJournalSet(configB, history);
    try {
      expect(set.journal?.health).toBe('open');
      expect(set.history[0]).toMatchObject({
        namespaceId: 'ns-a',
        refusal: 'definitely_not_opened: configuration',
      });
      expect(set.history[0]?.journal).toBeUndefined();
    } finally {
      await set.close();
    }
  }, 60_000);

  it('history alone (the current horizon also passed) still opens the store for history', async () => {
    const l = layout();
    const configA = await journalConfigFromEnvironment({
      ...l.env('ns-a', l.keyA, '2099-01-01T00:00:00Z'),
      AGENTBROWSER_JOURNAL_INITIALIZE: '1',
    });
    if (!configA) throw new Error('expected configuration');
    await (await openServiceJournal(configA)).close();
    l.writeHistory([{ ...serviceJournalHistoryTemplate(configA), keyFile: l.keyA }]);
    const passed = await journalConfigFromEnvironment(
      l.env('ns-b', l.keyB, '2001-01-01T00:00:00Z')
    );
    if (!passed) throw new Error('expected configuration');
    const history = await journalHistoryFromEnvironment(
      { AGENTBROWSER_JOURNAL_HISTORY_FILE: l.historyFile },
      passed
    );
    const set = await openServiceJournalSet(passed, history);
    try {
      expect(set.journal).toBeUndefined();
      expect(set.history[0]?.journal?.health).toBe('open');
    } finally {
      await set.close();
    }
  }, 60_000);
});

describe('searchJournalNamespaces (J3d merge semantics, stub journals)', () => {
  type Stub = Parameters<typeof searchJournalNamespaces>[0][number];
  const record = (namespaceId: string, operationId: string, n: number) =>
    ({
      namespaceId,
      revision: 1,
      dispatched: false,
      identity: { key: { operationId, sessionIncarnation: `${n}`.padStart(22, 'i') } },
    }) as never;
  const stub = (
    namespaceId: string,
    answer: 'found' | 'refused' | 'throw',
    records: unknown[] = [],
    health = 'open'
  ): Stub =>
    ({
      health,
      namespace: { namespaceId },
      findByOperation: async (query: { actionableOnly?: boolean }) => {
        calls.push({ namespaceId, actionableOnly: query.actionableOnly === true });
        if (answer === 'throw') throw new Error('io');
        if (answer === 'refused') return { kind: 'definitely_not_read', reason: 'fenced' };
        return { kind: 'found', records, truncated: false };
      },
    }) as unknown as Stub;
  let calls: Array<{ namespaceId: string; actionableOnly: boolean }> = [];
  afterEach(() => {
    calls = [];
  });

  it('merges namespaces, keeps each record with its owner, and forwards actionableOnly', async () => {
    const current = stub('ns-b', 'found', [record('ns-b', 'op', 1)]);
    const history = stub('ns-a', 'found', [record('ns-a', 'op', 2)]);
    const result = await searchJournalNamespaces([current, history], {
      tenantId: 'owner',
      operationId: 'op',
      actionableOnly: true,
    });
    expect(result.entries.map((entry) => entry.journal)).toEqual([current, history]);
    expect(result.unreadNamespaces).toEqual([]);
    expect(calls).toEqual([
      { namespaceId: 'ns-b', actionableOnly: true },
      { namespaceId: 'ns-a', actionableOnly: true },
    ]);
  });

  it('names every namespace it could not read — refused, throwing or unhealthy — never as absent', async () => {
    const result = await searchJournalNamespaces(
      [
        stub('ns-ok', 'found', [record('ns-ok', 'op', 1)]),
        stub('ns-refused', 'refused'),
        stub('ns-throws', 'throw'),
        stub('ns-poisoned', 'found', [], 'poisoned'),
      ],
      { tenantId: 'owner', operationId: 'op' }
    );
    expect(result.entries).toHaveLength(1);
    expect(result.unreadNamespaces).toEqual(['ns-refused', 'ns-throws', 'ns-poisoned']);
    // The unhealthy handle is never even asked.
    expect(calls.map((call) => call.namespaceId)).not.toContain('ns-poisoned');
  });

  it('holds the 16-record page bound across namespaces and reports truncation', async () => {
    const many = (namespaceId: string) =>
      stub(
        namespaceId,
        'found',
        Array.from({ length: 10 }, (_, n) => record(namespaceId, 'op', n))
      );
    const result = await searchJournalNamespaces([many('ns-a'), many('ns-b')], {
      tenantId: 'owner',
      operationId: 'op',
    });
    expect(result.entries).toHaveLength(16);
    expect(result.truncated).toBe(true);
  });
});
