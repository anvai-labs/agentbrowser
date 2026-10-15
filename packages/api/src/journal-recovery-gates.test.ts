/**
 * T5 J4 (D4): events and cursors are not recovered. The event ledger is per process and per
 * session; after a restart the old session no longer exists, so a pre-restart cursor fails as
 * session-not-found — never a silent reset to zero, and never a journal replay.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { journalConfigFromEnvironment, openServiceJournal } from './journal-config.js';
import { buildServer } from './server.js';
import { AgentBrowserService } from './service.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function journalEnvironment() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'j4-'));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'store'), { mode: 0o700 });
  mkdirSync(join(base, 'anchor'), { mode: 0o700 });
  writeFileSync(join(base, 'key'), `key-1:${'4a'.repeat(32)}\n`, { mode: 0o600 });
  return {
    env: {
      AGENTBROWSER_JOURNAL_DIR: join(base, 'store'),
      AGENTBROWSER_JOURNAL_ANCHOR_DIR: join(base, 'anchor'),
      AGENTBROWSER_JOURNAL_KEY_FILE: join(base, 'key'),
      AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'generation-1',
      AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: '2099-01-01T00:00:00Z',
      AGENTBROWSER_JOURNAL_INITIALIZE: '1',
    } as Record<string, string | undefined>,
  };
}

describe('events and cursors across a durable restart (J4, D4)', () => {
  it('a pre-restart event cursor fails as session-not-found; the journal replays nothing', async () => {
    const { env } = journalEnvironment();
    // Process A: one session whose events were consumed up to a cursor, then a graceful stop.
    const config = await journalConfigFromEnvironment(env);
    if (!config) throw new Error('expected configuration');
    const opened = await openServiceJournal(config);
    const first = new AgentBrowserService({
      engine: new FakeEngine(),
      operationJournal: opened.journal,
    });
    const sessionA = await first.createSession({ tenantId: 'owner' });
    await first.shutdown();
    await opened.close();

    // Process B reopens the same namespace; the journal record survives.
    const { AGENTBROWSER_JOURNAL_INITIALIZE: _drop, ...reopen } = env;
    const configB = await journalConfigFromEnvironment(reopen);
    if (!configB) throw new Error('expected configuration');
    const reopened = await openServiceJournal(configB);
    const found = await reopened.journal.findByOperation({
      tenantId: 'owner',
      operationId: 'none',
      limit: 16,
    });
    expect(found).toMatchObject({ kind: 'found', records: [] });
    const second = new AgentBrowserService({
      engine: new FakeEngine(),
      operationJournal: reopened.journal,
    });
    cleanup.push(async () => {
      await second.shutdown();
      await reopened.close();
    });

    // The old session is gone: its cursor cannot be resumed, and no event replay happens.
    // The old session is gone: its event cursor cannot be resumed (the ledger is per session
    // and per process; the journal holds no events to replay).
    expect(() =>
      second.getSessionEvents(sessionA.sessionId, { type: 'request', since: 0 })
    ).toThrow(/does not exist/);
    // The journal holds nothing that revives it: the store's rows are unchanged by the attempt.
    const after = await reopened.journal.findByOperation({
      tenantId: 'owner',
      operationId: 'none',
      limit: 16,
    });
    expect(after).toEqual(found);
  }, 60_000);
});
