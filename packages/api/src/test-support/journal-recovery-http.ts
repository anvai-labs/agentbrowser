/** Shared HTTP harness for the J3c recovery-write tests: seeded store, then a keyed server. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine } from '@agentbrowser/testkit';
import type { FastifyInstance } from 'fastify';
import { journalConfigFromEnvironment, openServiceJournal } from '../journal-config.js';
import { buildServer } from '../server.js';

const API_KEY = 'api-key-j3c-http';
const OPERATOR_KEY = 'operator-key-j3c-http-0001';

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
 * Seeds one record at an actionable state on a fresh store (the departed-process situation),
 * closes the seeding handle, then builds the REST server on the same store.
 */
export async function seedAndBuild(
  state: 'undispatched' | 'in_doubt',
  operationId: string,
  applicationAdapters?: import('@agentbrowser/control').ApplicationAdapter[]
) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'j3c-http-'));
  mkdirSync(join(base, 'store'), { mode: 0o700 });
  mkdirSync(join(base, 'anchor'), { mode: 0o700 });
  writeFileSync(join(base, 'key'), `key-1:${'7c'.repeat(32)}\n`, { mode: 0o600 });
  writeFileSync(join(base, 'operator.keys'), `${OPERATOR_KEY}:owner\n`, { mode: 0o600 });
  const config = await journalConfigFromEnvironment({
    AGENTBROWSER_JOURNAL_DIR: join(base, 'store'),
    AGENTBROWSER_JOURNAL_ANCHOR_DIR: join(base, 'anchor'),
    AGENTBROWSER_JOURNAL_KEY_FILE: join(base, 'key'),
    AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'generation-1',
    AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: '2099-01-01T00:00:00Z',
    AGENTBROWSER_JOURNAL_INITIALIZE: '1',
  });
  if (!config) throw new Error('expected configuration');
  const opened = await openServiceJournal(config);
  try {
    const reserved = await opened.journal.reserveIntent(intentOf(operationId));
    if (reserved.kind !== 'acknowledged') throw new Error('seed failed');
    if (state === 'in_doubt') {
      const dispatched = await opened.journal.markDispatch({
        identity: reserved.record.identity,
        expectedRevision: 1,
      });
      if (dispatched.kind !== 'acknowledged') throw new Error('seed dispatch failed');
    }
  } finally {
    await opened.close().catch(() => undefined);
  }

  const values = {
    AGENTBROWSER_JOURNAL_DIR: join(base, 'store'),
    AGENTBROWSER_JOURNAL_ANCHOR_DIR: join(base, 'anchor'),
    AGENTBROWSER_JOURNAL_KEY_FILE: join(base, 'key'),
    AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'generation-1',
    AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: '2099-01-01T00:00:00Z',
    AGENTBROWSER_OPERATOR_KEYS_FILE: join(base, 'operator.keys'),
  };
  Object.assign(process.env, values);
  let server: Awaited<ReturnType<typeof buildServer>>;
  try {
    server = await buildServer({
      engine: new FakeEngine(),
      apiKeys: new Map([[createHash('sha256').update(API_KEY).digest('hex'), 'owner']]),
      ...(applicationAdapters ? { applicationAdapters } : {}),
    });
  } catch (error) {
    for (const name of Object.keys(values)) delete process.env[name];
    rmSync(base, { recursive: true, force: true });
    throw error;
  }
  return {
    server,
    cleanup: async () => {
      await server.close();
      for (const name of Object.keys(values)) delete process.env[name];
      rmSync(base, { recursive: true, force: true });
    },
    headers: {
      apiKey: { authorization: `Bearer ${API_KEY}` },
      operator: { authorization: `Bearer ${OPERATOR_KEY}` },
    },
  } satisfies {
    server: FastifyInstance;
    cleanup: () => Promise<void>;
    headers: Record<string, { authorization: string }>;
  };
}
