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
    });
    expect(Buffer.from(config?.key ?? []).toString('hex')).toBe(KEY_HEX);
  });

  it.each([
    'AGENTBROWSER_JOURNAL_DIR',
    'AGENTBROWSER_JOURNAL_ANCHOR_DIR',
    'AGENTBROWSER_JOURNAL_KEY_FILE',
    'AGENTBROWSER_JOURNAL_RESTORE_GENERATION',
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
  it('opens an initialized store, gives each process its own namespace, and closes cleanly', async () => {
    const { env } = layout();
    const first = await journalConfigFromEnvironment({
      ...env,
      AGENTBROWSER_JOURNAL_INITIALIZE: '1',
    });
    if (!first) throw new Error('expected configuration');
    const opened = await openServiceJournal(first);
    try {
      expect(opened.journal.health).toBe('open');
      expect(opened.journal.namespace.fingerprintKeyId).toBe('key-2026-10');
      expect(opened.journal.namespace.acceptUntil).toBeGreaterThan(Date.now());
    } finally {
      await opened.close();
    }
    expect(opened.journal.health).toBe('closed');

    // A later start against the same store (no initialize) opens a fresh namespace.
    const again = await journalConfigFromEnvironment(env);
    if (!again) throw new Error('expected configuration');
    const reopened = await openServiceJournal(again);
    try {
      expect(reopened.journal.health).toBe('open');
      expect(reopened.journal.namespace.namespaceId).not.toBe(opened.journal.namespace.namespaceId);
    } finally {
      await reopened.close();
    }
  }, 60_000);

  it('refuses to start against an uninitialized store without AGENTBROWSER_JOURNAL_INITIALIZE', async () => {
    const { env } = layout();
    const config = await journalConfigFromEnvironment(env);
    if (!config) throw new Error('expected configuration');
    await expect(openServiceJournal(config)).rejects.toBeInstanceOf(JournalConfigError);
  }, 60_000);
});
