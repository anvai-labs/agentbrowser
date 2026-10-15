/**
 * T5 J-d: the trusted owner of the durable-journal configuration. Every variable comes from the
 * deployment, the key comes from a private file (never a variable), a partial configuration is a
 * startup refusal naming what is missing, and errors never carry key material.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JournalConfigError,
  journalConfigFromEnvironment,
  openServiceJournal,
} from './journal-config.js';

const KEY_HEX = 'ab'.repeat(32);
const posix = process.platform !== 'win32';
const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function layout(options: { keyLine?: string; keyMode?: number } = {}) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'svc-journal-'));
  cleanup.push(base);
  const directory = join(base, 'store');
  const anchorDirectory = join(base, 'anchor');
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(anchorDirectory, { mode: 0o700 });
  const keyFile = join(base, 'journal.key');
  writeFileSync(keyFile, `${options.keyLine ?? `key-2026-10:${KEY_HEX}`}\n`, { mode: 0o600 });
  if (options.keyMode !== undefined) chmodSync(keyFile, options.keyMode);
  return {
    base,
    env: {
      AGENTBROWSER_JOURNAL_DIR: directory,
      AGENTBROWSER_JOURNAL_ANCHOR_DIR: anchorDirectory,
      AGENTBROWSER_JOURNAL_KEY_FILE: keyFile,
      AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'generation-1',
      AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: '2099-01-01T00:00:00Z',
    } as Record<string, string | undefined>,
  };
}

describe('journalConfigFromEnvironment', () => {
  it('is absent when nothing is configured', async () => {
    await expect(journalConfigFromEnvironment({})).resolves.toBeUndefined();
  });

  it('reads a complete configuration with the key from its file', async () => {
    const { env } = layout();
    const config = await journalConfigFromEnvironment(env);
    expect(config).toMatchObject({
      directory: env.AGENTBROWSER_JOURNAL_DIR,
      anchorDirectory: env.AGENTBROWSER_JOURNAL_ANCHOR_DIR,
      restoreGeneration: 'generation-1',
      keyId: 'key-2026-10',
      initialize: false,
      namespaceId: 'agentbrowser',
      acceptUntil: Date.parse('2099-01-01T00:00:00Z'),
      maxRecords: 10_000,
    });
    expect(Buffer.from(config?.key ?? []).toString('hex')).toBe(KEY_HEX);
  });

  it.each([
    'AGENTBROWSER_JOURNAL_DIR',
    'AGENTBROWSER_JOURNAL_ANCHOR_DIR',
    'AGENTBROWSER_JOURNAL_KEY_FILE',
    'AGENTBROWSER_JOURNAL_RESTORE_GENERATION',
    'AGENTBROWSER_JOURNAL_ACCEPT_UNTIL',
  ])('refuses a partial configuration missing %s, naming it', async (missing) => {
    const { env } = layout();
    env[missing] = undefined;
    await expect(journalConfigFromEnvironment(env)).rejects.toThrow(
      new RegExp(`requires ${missing}|${missing}.*required`)
    );
  });

  it('refuses AGENTBROWSER_JOURNAL_INITIALIZE alone, and any value but 1', async () => {
    await expect(
      journalConfigFromEnvironment({ AGENTBROWSER_JOURNAL_INITIALIZE: '1' })
    ).rejects.toBeInstanceOf(JournalConfigError);
    const { env } = layout();
    await expect(
      journalConfigFromEnvironment({ ...env, AGENTBROWSER_JOURNAL_INITIALIZE: 'yes' })
    ).rejects.toThrow(/AGENTBROWSER_JOURNAL_INITIALIZE/);
    await expect(
      journalConfigFromEnvironment({ ...env, AGENTBROWSER_JOURNAL_INITIALIZE: '1' })
    ).resolves.toMatchObject({ initialize: true });
  });

  it('refuses relative directories', async () => {
    const { env } = layout();
    await expect(
      journalConfigFromEnvironment({ ...env, AGENTBROWSER_JOURNAL_DIR: 'relative/store' })
    ).rejects.toThrow(/AGENTBROWSER_JOURNAL_DIR must be an absolute path/);
  });

  it.each([
    ['AGENTBROWSER_JOURNAL_ACCEPT_UNTIL', '2027-01-01'],
    ['AGENTBROWSER_JOURNAL_ACCEPT_UNTIL', 'tomorrow'],
    ['AGENTBROWSER_JOURNAL_NAMESPACE', 'has space'],
    ['AGENTBROWSER_JOURNAL_MAX_RECORDS', '0'],
    ['AGENTBROWSER_JOURNAL_MAX_RECORDS', '1e4'],
    ['AGENTBROWSER_JOURNAL_MAX_RECORDS', '1000001'],
  ])('refuses %s=%s', async (name, bad) => {
    const { env } = layout();
    await expect(journalConfigFromEnvironment({ ...env, [name]: bad })).rejects.toThrow(
      new RegExp(name)
    );
  });

  it('an optional variable alone is still a partial configuration', async () => {
    await expect(
      journalConfigFromEnvironment({ AGENTBROWSER_JOURNAL_NAMESPACE: 'x' })
    ).rejects.toThrow(/requires/);
  });

  it('refuses a malformed restore generation', async () => {
    const { env } = layout();
    await expect(
      journalConfigFromEnvironment({ ...env, AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'a b' })
    ).rejects.toThrow(/AGENTBROWSER_JOURNAL_RESTORE_GENERATION/);
  });

  it.each([
    ['no key id', KEY_HEX],
    ['a short key', `key-1:${'ab'.repeat(16)}`],
    ['a long key', `key-1:${'ab'.repeat(65)}`],
    ['odd hex', `key-1:${KEY_HEX}a`],
    ['non-hex', `key-1:${'zz'.repeat(32)}`],
    ['a bad key id', `key 1:${KEY_HEX}`],
    ['two keys', `key-1:${KEY_HEX}\nkey-2:${KEY_HEX}`],
  ])('refuses a key file with %s, never echoing key material', async (_name, keyLine) => {
    const { env } = layout({ keyLine });
    const error = await journalConfigFromEnvironment(env).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JournalConfigError);
    expect(String((error as Error).message)).not.toMatch(/abab|zzzz/);
  });

  it.skipIf(!posix)('refuses a key file readable by group or others', async () => {
    const { env } = layout({ keyMode: 0o640 });
    await expect(journalConfigFromEnvironment(env)).rejects.toThrow(/chmod 600/);
  });
});

describe('openServiceJournal (real SQLite store)', () => {
  it('reopens the same namespace on every start, keeping its records, and refuses a changed descriptor', async () => {
    const { env } = layout();
    const first = await journalConfigFromEnvironment({
      ...env,
      AGENTBROWSER_JOURNAL_INITIALIZE: '1',
    });
    if (!first) throw new Error('expected configuration');
    const opened = await openServiceJournal(first);
    try {
      expect(opened.journal.health).toBe('open');
      expect(opened.journal.namespace).toMatchObject({
        namespaceId: 'agentbrowser',
        fingerprintKeyId: 'key-2026-10',
        acceptUntil: Date.parse('2099-01-01T00:00:00Z'),
      });
    } finally {
      await opened.close();
    }
    expect(opened.journal.health).toBe('closed');

    // A later start with the same configuration (no initialize) reopens the same namespace.
    const again = await journalConfigFromEnvironment(env);
    if (!again) throw new Error('expected configuration');
    const reopened = await openServiceJournal(again);
    try {
      expect(reopened.journal.health).toBe('open');
      expect(reopened.journal.namespace.namespaceId).toBe('agentbrowser');
    } finally {
      await reopened.close();
    }

    // Changing an immutable horizon under the same namespace is refused, not forked.
    const changed = await journalConfigFromEnvironment({
      ...env,
      AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: '2098-01-01T00:00:00Z',
    });
    if (!changed) throw new Error('expected configuration');
    await expect(openServiceJournal(changed)).rejects.toThrow(/configuration/);
  }, 60_000);

  it('refuses a namespace whose accept horizon has passed, before starting the store', async () => {
    const { env } = layout();
    const config = await journalConfigFromEnvironment({
      ...env,
      AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: '2001-01-01T00:00:00Z',
    });
    if (!config) throw new Error('expected configuration');
    await expect(openServiceJournal(config)).rejects.toThrow(/has passed/);
  });

  it('refuses to start against an uninitialized store without AGENTBROWSER_JOURNAL_INITIALIZE', async () => {
    const { env } = layout();
    const config = await journalConfigFromEnvironment(env);
    if (!config) throw new Error('expected configuration');
    await expect(openServiceJournal(config)).rejects.toBeInstanceOf(JournalConfigError);
  }, 60_000);
});
