/**
 * T5 J-d (C4b runtime wiring): the trusted owner of the durable-journal configuration.
 *
 * The journal is opt-in. It is configured only by the deployment, never by request input:
 *
 * - `AGENTBROWSER_JOURNAL_DIR` and `AGENTBROWSER_JOURNAL_ANCHOR_DIR`: existing, private, local
 *   directories the operator provisions (the store itself refuses any layout it does not accept;
 *   see `docs/spec/design/t5-operator-reconciliation.md`).
 * - `AGENTBROWSER_JOURNAL_KEY_FILE`: one `keyId:hex` line holding the 32–64 byte fingerprint key.
 *   A file, never a variable, readable by its owner only.
 * - `AGENTBROWSER_JOURNAL_RESTORE_GENERATION`: the operator-managed restore generation.
 * - `AGENTBROWSER_JOURNAL_INITIALIZE=1`: explicit first initialization of an empty store; never
 *   repairs an existing one.
 *
 * Any of them without the others is a startup refusal naming what is missing. Errors name
 * variables and positions, never key material.
 */
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  type JournalNamespace,
  type OperationJournal,
  openJournalSqliteOperationJournalAdapter,
  openOperationJournal,
} from '@agentbrowser/control';

export class JournalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalConfigError';
  }
}

export interface ServiceJournalConfig {
  readonly directory: string;
  readonly anchorDirectory: string;
  readonly restoreGeneration: string;
  readonly initialize: boolean;
  readonly keyId: string;
  readonly key: Uint8Array;
}

type JournalEnvironment = Readonly<Record<string, string | undefined>>;

const REQUIRED = [
  'AGENTBROWSER_JOURNAL_DIR',
  'AGENTBROWSER_JOURNAL_ANCHOR_DIR',
  'AGENTBROWSER_JOURNAL_KEY_FILE',
  'AGENTBROWSER_JOURNAL_RESTORE_GENERATION',
] as const;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const KEY_HEX = /^(?:[0-9a-fA-F]{2}){32,64}$/;

/** Reads the journal configuration, or `undefined` when the deployment configures none. */
export async function journalConfigFromEnvironment(
  env: JournalEnvironment = process.env
): Promise<ServiceJournalConfig | undefined> {
  const value = (name: string) => {
    const raw = env[name]?.trim();
    return raw === undefined || raw === '' ? undefined : raw;
  };
  const initializeRaw = value('AGENTBROWSER_JOURNAL_INITIALIZE');
  const present = REQUIRED.filter((name) => value(name) !== undefined);
  if (present.length === 0 && initializeRaw === undefined) return undefined;
  const missing = REQUIRED.filter((name) => value(name) === undefined);
  if (missing.length > 0)
    throw new JournalConfigError(
      `Invalid configuration: the durable journal requires ${missing.join(', ')}`
    );
  if (initializeRaw !== undefined && initializeRaw !== '1')
    throw new JournalConfigError(
      'Invalid configuration: AGENTBROWSER_JOURNAL_INITIALIZE must be 1 or unset'
    );
  const directory = value('AGENTBROWSER_JOURNAL_DIR') as string;
  const anchorDirectory = value('AGENTBROWSER_JOURNAL_ANCHOR_DIR') as string;
  for (const [name, path] of [
    ['AGENTBROWSER_JOURNAL_DIR', directory],
    ['AGENTBROWSER_JOURNAL_ANCHOR_DIR', anchorDirectory],
  ] as const)
    if (!isAbsolute(path))
      throw new JournalConfigError(`Invalid configuration: ${name} must be an absolute path`);
  const restoreGeneration = value('AGENTBROWSER_JOURNAL_RESTORE_GENERATION') as string;
  if (!IDENTIFIER.test(restoreGeneration))
    throw new JournalConfigError(
      'Invalid configuration: AGENTBROWSER_JOURNAL_RESTORE_GENERATION must be 1-128 letters, digits, "_" or "-"'
    );
  const { keyId, key } = await readKeyFile(value('AGENTBROWSER_JOURNAL_KEY_FILE') as string);
  return {
    directory,
    anchorDirectory,
    restoreGeneration,
    initialize: initializeRaw === '1',
    keyId,
    key,
  };
}

async function readKeyFile(path: string): Promise<{ keyId: string; key: Uint8Array }> {
  const invalid = (detail: string) =>
    new JournalConfigError(`Invalid AGENTBROWSER_JOURNAL_KEY_FILE: ${detail}`);
  let text: string;
  try {
    if (process.platform !== 'win32' && ((await stat(path)).mode & 0o077) !== 0)
      throw invalid('the file must be readable by its owner only (chmod 600)');
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof JournalConfigError) throw error;
    throw invalid('the file cannot be read');
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (lines.length !== 1) throw invalid('expected exactly one keyId:hex line');
  const line = lines[0] as string;
  const at = line.indexOf(':');
  if (at <= 0) throw invalid('expected keyId:hex');
  const keyId = line.slice(0, at);
  const hex = line.slice(at + 1);
  if (!IDENTIFIER.test(keyId))
    throw invalid('the key id must be 1-128 letters, digits, "_" or "-"');
  if (!KEY_HEX.test(hex)) throw invalid('the key must be 32-64 bytes of hexadecimal');
  return { keyId, key: Uint8Array.from(Buffer.from(hex, 'hex')) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deployment bounds for the service's namespace. Record size, in-flight and timeout are the
 * values the SQLite qualification gates run with. The others are operator capacity, and a full
 * namespace or store refuses durable work (or startup) instead of evicting accepted records:
 *
 * - `maxRecords`: durable writes one process start can journal (each reserves at most
 *   `maxRecordBytes`, so at most about 160 MB).
 * - `maxNamespaces`: a STORE-WIDE constant (every namespace in a store must repeat the first
 *   one's value), so it can never change for an existing store. Each process start opens one
 *   namespace, retired once settled and past retention; 1,024 allows about 27 starts a day
 *   within the 37-day namespace lifetime below.
 */
export const SERVICE_JOURNAL_BOUNDS = Object.freeze({
  maxRecordBytes: 16_384,
  maxRecords: 10_000,
  maxNamespaces: 1_024,
  maxInFlight: 8,
  timeoutMs: 5_000,
});
/**
 * New durable intents are accepted for 7 days after startup (after that, durable is no longer
 * advertised or accepted until the next start); journaled records are retained 30 days more.
 */
export const SERVICE_JOURNAL_ACCEPT_MS = 7 * DAY_MS;
export const SERVICE_JOURNAL_RETAIN_MS = 30 * DAY_MS;
export const SERVICE_JOURNAL_FINALIZATION_MS = 60_000;

export interface ServiceJournal {
  readonly journal: OperationJournal;
  close(): Promise<void>;
}

/**
 * Opens the configured store and one fresh namespace for this process. Any refusal stops startup
 * (there is no ephemeral fallback for a configured journal) and leaves no storage child running.
 */
export async function openServiceJournal(
  config: ServiceJournalConfig,
  options: { now?: () => number } = {}
): Promise<ServiceJournal> {
  const now = options.now ?? Date.now;
  let adapter: Awaited<ReturnType<typeof openJournalSqliteOperationJournalAdapter>>;
  try {
    adapter = await openJournalSqliteOperationJournalAdapter({
      directory: config.directory,
      anchorDirectory: config.anchorDirectory,
      restoreGeneration: config.restoreGeneration,
      initialize: config.initialize,
    });
  } catch {
    throw new JournalConfigError(
      'The durable journal store did not start; check AGENTBROWSER_JOURNAL_DIR, AGENTBROWSER_JOURNAL_ANCHOR_DIR and the store layout'
    );
  }
  const acceptUntil = now() + SERVICE_JOURNAL_ACCEPT_MS;
  const namespace: JournalNamespace = {
    schemaVersion: 1,
    namespaceId: `service-${randomUUID()}`,
    fingerprintVersion: 1,
    fingerprintKeyId: config.keyId,
    restoreGeneration: config.restoreGeneration,
    acceptUntil,
    retainUntil: acceptUntil + SERVICE_JOURNAL_RETAIN_MS,
    maxFinalizationMs: SERVICE_JOURNAL_FINALIZATION_MS,
    bounds: SERVICE_JOURNAL_BOUNDS,
  };
  const opened = await openOperationJournal(adapter, namespace, config.key).catch(() => undefined);
  if (opened?.kind !== 'opened') {
    await adapter.dispose().catch(() => undefined);
    const reason = opened === undefined ? 'error' : `${opened.kind}: ${opened.reason}`;
    throw new JournalConfigError(
      `The durable journal did not open (${reason}); an uninitialized store needs AGENTBROWSER_JOURNAL_INITIALIZE=1 once, and a refused layout follows docs/spec/design/t5-operator-reconciliation.md`
    );
  }
  const journal = opened.journal;
  let closing: Promise<void> | undefined;
  return {
    journal,
    close: () => {
      closing ??= (async () => {
        await journal.close().catch(() => undefined);
        await adapter.dispose().catch(() => undefined);
      })();
      return closing;
    },
  };
}
