import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The base every journal fixture grows from: a temp base with store/ and anchor/
 * (0700). Register `dispose()` in the suite's cleanup. */
function baseTree(tag: string) {
  const baseDir = mkdtempSync(join(realpathSync(tmpdir()), tag));
  const storeDir = join(baseDir, 'store');
  const anchorDir = join(baseDir, 'anchor');
  mkdirSync(storeDir, { mode: 0o700 });
  mkdirSync(anchorDir, { mode: 0o700 });
  return {
    baseDir,
    storeDir,
    anchorDir,
    dispose: () => rmSync(baseDir, { recursive: true, force: true }),
  };
}

/** One private journal tree: the base plus one key file (0600). */
function tree(tag: string, keyHex: string) {
  const t = baseTree(tag);
  const keyFile = join(t.baseDir, 'key');
  writeFileSync(keyFile, `key-1:${keyHex.repeat(32)}\n`, { mode: 0o600 });
  return { ...t, keyFile };
}

/**
 * The single-key journal fixture (the durable suites): the full JOURNAL_* environment,
 * initialized, with a far-future accept horizon. Callers either assign it to process.env
 * (with their own save/restore) or pass it straight to journalConfigFromEnvironment.
 */
export function journalTree(tag: string, keyHex: string, options: { initialize?: boolean } = {}) {
  const t = tree(tag, keyHex);
  return {
    ...t,
    env: {
      AGENTBROWSER_JOURNAL_DIR: t.storeDir,
      AGENTBROWSER_JOURNAL_ANCHOR_DIR: t.anchorDir,
      AGENTBROWSER_JOURNAL_KEY_FILE: t.keyFile,
      AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'generation-1',
      AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: '2099-01-01T00:00:00Z',
      ...(options.initialize === false ? {} : { AGENTBROWSER_JOURNAL_INITIALIZE: '1' }),
    } as Record<string, string>,
  };
}

/**
 * The key-rollover fixture (the journal-history family): TWO journal keys so a suite can
 * rotate between them, plus a history file path and an env builder parameterized by
 * namespace, key file and accept horizon.
 */
export function journalRolloverTree(tag: string) {
  const t = baseTree(tag);
  const keyA = join(t.baseDir, 'key-a');
  const keyB = join(t.baseDir, 'key-b');
  writeFileSync(keyA, `key-a:${'a1'.repeat(32)}\n`, { mode: 0o600 });
  writeFileSync(keyB, `key-b:${'b2'.repeat(32)}\n`, { mode: 0o600 });
  const historyFile = join(t.baseDir, 'history.json');
  return {
    baseDir: t.baseDir,
    keyA,
    keyB,
    historyFile,
    envFor: (namespace: string, keyFile: string, acceptUntil: string) =>
      ({
        AGENTBROWSER_JOURNAL_DIR: t.storeDir,
        AGENTBROWSER_JOURNAL_ANCHOR_DIR: t.anchorDir,
        AGENTBROWSER_JOURNAL_KEY_FILE: keyFile,
        AGENTBROWSER_JOURNAL_RESTORE_GENERATION: 'generation-1',
        AGENTBROWSER_JOURNAL_ACCEPT_UNTIL: acceptUntil,
        AGENTBROWSER_JOURNAL_NAMESPACE: namespace,
      }) as Record<string, string>,
    dispose: t.dispose,
  };
}
