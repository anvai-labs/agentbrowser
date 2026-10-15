/**
 * T5 J3d (D7) over HTTP: after a rotation, a history namespace's records are listed by status,
 * found by lookup (tagged with their namespace) and recoverable by the operator — the write
 * commits in the namespace that owns the record. A refused history entry is UNREAD, never absent.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  journalConfigFromEnvironment,
  openServiceJournal,
  serviceJournalHistoryTemplate,
} from './journal-config.js';
import { buildServer } from './server.js';

const API_KEY = 'api-key-j3d-http';
const OPERATOR_KEY = 'operator-key-j3d-http-0001';
const apiHeaders = { authorization: `Bearer ${API_KEY}` };
const operatorHeaders = { authorization: `Bearer ${OPERATOR_KEY}` };
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function layout() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'j3d-http-'));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'store'), { mode: 0o700 });
  mkdirSync(join(base, 'anchor'), { mode: 0o700 });
  const keyA = join(base, 'key-a');
  const keyB = join(base, 'key-b');
  writeFileSync(keyA, `key-a:${'a1'.repeat(32)}\n`, { mode: 0o600 });
  writeFileSync(keyB, `key-b:${'b2'.repeat(32)}\n`, { mode: 0o600 });
  const operatorKeys = join(base, 'operator.keys');
  writeFileSync(operatorKeys, `${OPERATOR_KEY}:owner\n`, { mode: 0o600 });
  const historyFile = join(base, 'history.json');
  const env = (namespace: string, keyFile: string, acceptUntil: string) => ({
    AGENTBROWSER_JOURNAL_DIR: join(base, 'store'),
    AGENTBROWSER_JOURNAL_ANCHOR_DIR: join(base, 'anchor'),
    AGENTBROWSER_JOURNAL_KEY_FILE: keyFile,
    AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'generation-1',
    AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: acceptUntil,
    AGENTBROWSER_JOURNAL_NAMESPACE: namespace,
  });
  return { keyA, keyB, operatorKeys, historyFile, env };
}

async function server(
  env: Record<string, string | undefined>,
  applicationAdapters?: import('@agentbrowser/control').ApplicationAdapter[]
) {
  const names = Object.keys(env);
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  cleanup.push(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  cleanup.push(() => warn.mockRestore());
  const built = await buildServer({
    engine: new FakeEngine(),
    apiKeys: new Map([[createHash('sha256').update(API_KEY).digest('hex'), 'owner']]),
    ...(applicationAdapters ? { applicationAdapters } : {}),
  });
  cleanup.push(() => built.close());
  return { built, warn };
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

/**
 * A namespace with one record (in doubt by default), then its horizon passes. Returns its
 * history template.
 */
async function seedRotatedNamespace(
  l: ReturnType<typeof layout>,
  options: {
    namespace?: string;
    keyFile?: string;
    operationId?: string;
    state?: 'undispatched' | 'in_doubt';
  } = {}
) {
  const horizon = new Date(Date.now() + 2_000).toISOString();
  const configA = await journalConfigFromEnvironment({
    ...l.env(options.namespace ?? 'ns-a', options.keyFile ?? l.keyA, horizon),
    AGENTBROWSER_JOURNAL_INITIALIZE: '1',
  });
  if (!configA) throw new Error('expected configuration');
  const a = await openServiceJournal(configA);
  const reserved = await a.journal.reserveIntent(intentOf(options.operationId ?? 'rotated-op'));
  if (reserved.kind !== 'acknowledged') throw new Error('seed failed');
  if ((options.state ?? 'in_doubt') === 'in_doubt')
    await a.journal.markDispatch({ identity: reserved.record.identity, expectedRevision: 1 });
  await a.close();
  await new Promise((done) => setTimeout(done, 2_300));
  return serviceJournalHistoryTemplate(configA);
}

describe('history namespaces over HTTP (J3d)', () => {
  it('status lists the rotated namespace; lookup finds its record; the operator settles it there', async () => {
    const l = layout();
    const template = await seedRotatedNamespace(l);
    writeFileSync(
      l.historyFile,
      JSON.stringify({ schemaVersion: 1, namespaces: [{ ...template, keyFile: l.keyA }] }),
      { mode: 0o600 }
    );
    const { built } = await server({
      ...l.env('ns-b', l.keyB, '2099-01-01T00:00:00Z'),
      AGENTBROWSER_JOURNAL_HISTORY_FILE: l.historyFile,
      AGENTBROWSER_OPERATOR_KEYS_FILE: l.operatorKeys,
    });

    const status = await built.inject({ method: 'GET', url: '/v1/journal', headers: apiHeaders });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({
      namespace: 'ns-b',
      health: 'open',
      history: [{ namespace: 'ns-a', state: 'open', acceptUntil: template.acceptUntil }],
    });

    const lookup = () =>
      built.inject({
        method: 'GET',
        url: '/v1/journal/operations/rotated-op',
        headers: apiHeaders,
      });
    const before = await lookup();
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toMatchObject({
      absent: false,
      records: [{ namespace: 'ns-a', classification: 'in_doubt', actionable: true }],
    });
    expect(before.json()).not.toHaveProperty('unreadNamespaces');

    const settled = await built.inject({
      method: 'POST',
      url: '/v1/journal/operations/rotated-op/settle',
      headers: operatorHeaders,
    });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json()).toEqual({ settled: 1, truncated: false });
    // The terminal was committed in the namespace that owns the record.
    expect((await lookup()).json()).toMatchObject({
      records: [{ namespace: 'ns-a', classification: 'settled_unknown', actionable: false }],
    });
  }, 60_000);

  it('reconcile resolves a history record in the namespace that owns it', async () => {
    const l = layout();
    const template = await seedRotatedNamespace(l);
    writeFileSync(
      l.historyFile,
      JSON.stringify({ schemaVersion: 1, namespaces: [{ ...template, keyFile: l.keyA }] }),
      { mode: 0o600 }
    );
    const { built } = await server(
      {
        ...l.env('ns-b', l.keyB, '2099-01-01T00:00:00Z'),
        AGENTBROWSER_JOURNAL_HISTORY_FILE: l.historyFile,
        AGENTBROWSER_OPERATOR_KEYS_FILE: l.operatorKeys,
      },
      [
        {
          id: 'a',
          authorize: () => true,
          operations: {},
          receipt: async () => ({}),
          reconcile: async () => ({ status: 'committed' }),
        },
      ]
    );
    const reconciled = await built.inject({
      method: 'POST',
      url: '/v1/journal/operations/rotated-op/reconcile',
      headers: operatorHeaders,
    });
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    expect(reconciled.json()).toEqual({ reconciled: 1, unresolved: 0, truncated: false });
    const after = await built.inject({
      method: 'GET',
      url: '/v1/journal/operations/rotated-op',
      headers: apiHeaders,
    });
    expect(after.json()).toMatchObject({
      records: [{ namespace: 'ns-a', classification: 'completed', actionable: false }],
    });
  }, 60_000);

  it('a refused history entry is reported and makes lookups partial — unread, never absent', async () => {
    const l = layout();
    const template = await seedRotatedNamespace(l);
    // The wrong key file: the store refuses ns-a's descriptor.
    writeFileSync(
      l.historyFile,
      JSON.stringify({ schemaVersion: 1, namespaces: [{ ...template, keyFile: l.keyB }] }),
      { mode: 0o600 }
    );
    const { built, warn } = await server({
      ...l.env('ns-b', l.keyB, '2099-01-01T00:00:00Z'),
      AGENTBROWSER_JOURNAL_HISTORY_FILE: l.historyFile,
      AGENTBROWSER_OPERATOR_KEYS_FILE: l.operatorKeys,
    });
    expect(warn.mock.calls.flat().join(' ')).toMatch(/ns-a did not open/);
    const status = await built.inject({ method: 'GET', url: '/v1/journal', headers: apiHeaders });
    expect(status.json()).toMatchObject({
      health: 'open',
      history: [
        { namespace: 'ns-a', state: 'refused', reason: 'definitely_not_opened: configuration' },
      ],
    });
    const lookup = await built.inject({
      method: 'GET',
      url: '/v1/journal/operations/rotated-op',
      headers: apiHeaders,
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({
      absent: false,
      records: [],
      unreadNamespaces: ['ns-a'],
    });
    // Recovery is equally honest: nothing found, but history unread — 503, never 404.
    const settle = await built.inject({
      method: 'POST',
      url: '/v1/journal/operations/rotated-op/settle',
      headers: operatorHeaders,
    });
    expect(settle.statusCode).toBe(503);
    expect(settle.json().error.code).toBe('JOURNAL_UNAVAILABLE');
  }, 60_000);

  it('refuses a history file without the journal configuration', async () => {
    const l = layout();
    writeFileSync(l.historyFile, JSON.stringify({ schemaVersion: 1, namespaces: [] }), {
      mode: 0o600,
    });
    await expect(server({ AGENTBROWSER_JOURNAL_HISTORY_FILE: l.historyFile })).rejects.toThrow(
      /requires the durable journal configuration/
    );
  });
});

describe('history namespaces over HTTP, review round 1 (J3d)', () => {
  const lookup = (built: Awaited<ReturnType<typeof server>>['built'], operationId: string) =>
    built.inject({
      method: 'GET',
      url: `/v1/journal/operations/${operationId}`,
      headers: apiHeaders,
    });
  const act = (
    built: Awaited<ReturnType<typeof server>>['built'],
    operationId: string,
    action: 'close' | 'settle'
  ) =>
    built.inject({
      method: 'POST',
      url: `/v1/journal/operations/${operationId}/${action}`,
      headers: operatorHeaders,
    });

  it('F1: a past-horizon CURRENT namespace stays readable and recoverable — with or without history', async () => {
    const l = layout();
    const templateB = await seedRotatedNamespace(l, {
      namespace: 'ns-b',
      keyFile: l.keyB,
      operationId: 'current-op',
    });
    // Restarted with the SAME (now passed) horizon and no history file.
    const { built } = await server({
      ...l.env('ns-b', l.keyB, templateB.acceptUntil),
      AGENTBROWSER_OPERATOR_KEYS_FILE: l.operatorKeys,
    });
    const status = (
      await built.inject({ method: 'GET', url: '/v1/journal', headers: apiHeaders })
    ).json();
    // Durable work is not offered (no current health), but the namespace is listed recover-only.
    expect(status).not.toHaveProperty('health');
    expect(status.recoveryQualified).toBe(false);
    expect(status.history).toEqual([
      expect.objectContaining({ namespace: 'ns-b', current: true, state: 'open' }),
    ]);
    const before = await lookup(built, 'current-op');
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toMatchObject({
      absent: false,
      records: [{ namespace: 'ns-b', classification: 'in_doubt' }],
    });
    const settled = await act(built, 'current-op', 'settle');
    expect(settled.statusCode, settled.body).toBe(200);
    expect((await lookup(built, 'current-op')).json()).toMatchObject({
      records: [{ namespace: 'ns-b', classification: 'settled_unknown' }],
    });
  }, 60_000);

  it('F4: close lands a never-dispatched history record in the namespace that owns it', async () => {
    const l = layout();
    const template = await seedRotatedNamespace(l, {
      state: 'undispatched',
      operationId: 'old-op',
    });
    writeFileSync(
      l.historyFile,
      JSON.stringify({ schemaVersion: 1, namespaces: [{ ...template, keyFile: l.keyA }] }),
      { mode: 0o600 }
    );
    const { built } = await server({
      ...l.env('ns-b', l.keyB, '2099-01-01T00:00:00Z'),
      AGENTBROWSER_JOURNAL_HISTORY_FILE: l.historyFile,
      AGENTBROWSER_OPERATOR_KEYS_FILE: l.operatorKeys,
    });
    const closed = await act(built, 'old-op', 'close');
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toEqual({ closed: 1, truncated: false });
    expect((await lookup(built, 'old-op')).json()).toMatchObject({
      records: [{ namespace: 'ns-a', classification: 'failed_before_dispatch' }],
    });
  }, 60_000);

  it('F6: partial recovery acts on what it found and names what it could not read', async () => {
    const l = layout();
    const template = await seedRotatedNamespace(l);
    writeFileSync(
      l.historyFile,
      JSON.stringify({
        schemaVersion: 1,
        namespaces: [
          { ...template, keyFile: l.keyA },
          // Listed too early (future horizon): reported, never opened, read as unread.
          {
            ...template,
            namespace: 'ns-early',
            acceptUntil: '2099-01-01T00:00:00.000Z',
            keyFile: l.keyA,
          },
        ],
      }),
      { mode: 0o600 }
    );
    const { built } = await server({
      ...l.env('ns-b', l.keyB, '2099-01-01T00:00:00Z'),
      AGENTBROWSER_JOURNAL_HISTORY_FILE: l.historyFile,
      AGENTBROWSER_OPERATOR_KEYS_FILE: l.operatorKeys,
    });
    const settled = await act(built, 'rotated-op', 'settle');
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json()).toEqual({
      settled: 1,
      truncated: false,
      unreadNamespaces: ['ns-early'],
    });
  }, 60_000);
});
