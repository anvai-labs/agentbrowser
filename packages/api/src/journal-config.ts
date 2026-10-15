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
 * - `AGENTBROWSER_JOURNAL_ACCEPT_UNTIL`: the ISO-8601 instant until which the namespace accepts
 *   new durable intents; records are retained 30 days beyond it.
 * - `AGENTBROWSER_JOURNAL_NAMESPACE` (optional, default `agentbrowser`) and
 *   `AGENTBROWSER_JOURNAL_MAX_RECORDS` (optional, default 10,000).
 * - `AGENTBROWSER_JOURNAL_INITIALIZE=1`: explicit first initialization of an empty store; never
 *   repairs an existing one.
 *
 * The namespace descriptor is derived entirely from this configuration, so every start reopens
 * the SAME namespace and journaled records survive restarts. Its horizons and bounds are
 * immutable: a changed value under the same namespace is refused by the store (startup aborts).
 * Rotating means configuring a new namespace name with a new horizon.
 *
 * Any of them without the others is a startup refusal naming what is missing. Errors name
 * variables and positions, never key material.
 */
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
  readonly namespaceId: string;
  readonly acceptUntil: number;
  readonly maxRecords: number;
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
  'AGENTBROWSER_JOURNAL_ACCEPT_UNTIL',
] as const;
const OPTIONAL = ['AGENTBROWSER_JOURNAL_NAMESPACE', 'AGENTBROWSER_JOURNAL_MAX_RECORDS'] as const;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
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
  const present = [...REQUIRED, ...OPTIONAL].filter((name) => value(name) !== undefined);
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
  const acceptRaw = value('AGENTBROWSER_JOURNAL_ACCEPT_UNTIL') as string;
  const acceptUntil = ISO_INSTANT.test(acceptRaw) ? Date.parse(acceptRaw) : Number.NaN;
  if (!Number.isSafeInteger(acceptUntil) || acceptUntil <= 0)
    throw new JournalConfigError(
      'Invalid configuration: AGENTBROWSER_JOURNAL_ACCEPT_UNTIL must be an ISO-8601 instant with a time zone, e.g. 2027-01-01T00:00:00Z'
    );
  const namespaceId = value('AGENTBROWSER_JOURNAL_NAMESPACE') ?? 'agentbrowser';
  if (!IDENTIFIER.test(namespaceId))
    throw new JournalConfigError(
      'Invalid configuration: AGENTBROWSER_JOURNAL_NAMESPACE must be 1-128 letters, digits, "_" or "-"'
    );
  const maxRecordsRaw = value('AGENTBROWSER_JOURNAL_MAX_RECORDS');
  const maxRecords = maxRecordsRaw === undefined ? DEFAULT_MAX_RECORDS : Number(maxRecordsRaw);
  if (
    !/^\d+$/.test(maxRecordsRaw ?? String(DEFAULT_MAX_RECORDS)) ||
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > 1_000_000
  )
    throw new JournalConfigError(
      'Invalid configuration: AGENTBROWSER_JOURNAL_MAX_RECORDS must be an integer from 1 to 1000000'
    );
  const { keyId, key } = await readKeyFile(value('AGENTBROWSER_JOURNAL_KEY_FILE') as string);
  return {
    namespaceId,
    acceptUntil,
    maxRecords,
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

const DEFAULT_MAX_RECORDS = 10_000;

/**
 * COMPATIBILITY: every value below is part of each deployed namespace's immutable descriptor.
 * Changing one in a release makes existing namespaces refuse to open (`configuration`) until the
 * operator configures a new namespace. Change them only with a CHANGELOG migration note.
 *
 * Fixed bounds for the service's namespace. Record size, in-flight and timeout are the values the
 * SQLite qualification gates run with. `maxNamespaces` is a STORE-WIDE constant (every namespace
 * in a store must repeat the first one's value), so it never changes for an existing store; a
 * namespace is stable across restarts, so it counts operator rotations, not starts. A full
 * namespace or store refuses durable work (or startup) instead of evicting accepted records.
 */
export const SERVICE_JOURNAL_BOUNDS = Object.freeze({
  maxRecordBytes: 16_384,
  maxNamespaces: 64,
  maxInFlight: 8,
  timeoutMs: 5_000,
});
/** Journaled records are retained this long beyond the accept horizon. */
export const SERVICE_JOURNAL_RETAIN_MS = 30 * DAY_MS;
export const SERVICE_JOURNAL_FINALIZATION_MS = 60_000;

/** The namespace descriptor, derived only from configuration so every start reopens it. */
export function serviceJournalNamespace(config: ServiceJournalConfig): JournalNamespace {
  return {
    schemaVersion: 1,
    namespaceId: config.namespaceId,
    fingerprintVersion: 1,
    fingerprintKeyId: config.keyId,
    restoreGeneration: config.restoreGeneration,
    acceptUntil: config.acceptUntil,
    retainUntil: config.acceptUntil + SERVICE_JOURNAL_RETAIN_MS,
    maxFinalizationMs: SERVICE_JOURNAL_FINALIZATION_MS,
    bounds: { ...SERVICE_JOURNAL_BOUNDS, maxRecords: config.maxRecords },
  };
}

/**
 * The accepted design's qualified matrix: Node 24 on Linux (CI) or the macOS leg. Node 22.13+ can
 * START the journal but is unqualified until a Node 22 leg exists; Windows has no journal leg.
 */
export function journalRuntimeQualified(
  platform: NodeJS.Platform = process.platform,
  nodeVersion: string = process.versions.node
): boolean {
  const major = Number(nodeVersion.split('.')[0]);
  return (platform === 'linux' || platform === 'darwin') && major === 24;
}

export interface ServiceJournal {
  readonly journal: OperationJournal;
  close(): Promise<void>;
}

/**
 * Opens the configured store and the configured namespace (created on first use, reopened on
 * every later start). Any refusal stops startup (there is no ephemeral fallback for a configured
 * journal) and leaves no storage child running.
 */
export async function openServiceJournal(
  config: ServiceJournalConfig,
  options: { now?: () => number } = {}
): Promise<ServiceJournal> {
  const now = options.now ?? Date.now;
  if (config.acceptUntil <= now())
    throw new JournalConfigError(
      'AGENTBROWSER_JOURNAL_ACCEPT_UNTIL has passed: this namespace no longer accepts durable work; configure a new AGENTBROWSER_JOURNAL_NAMESPACE with a new horizon'
    );
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
      'The durable journal store did not start: another process may hold it (one server per store), or AGENTBROWSER_JOURNAL_DIR / AGENTBROWSER_JOURNAL_ANCHOR_DIR or the store layout is refused (docs/spec/design/t5-operator-reconciliation.md). The journal needs Node 22.13 or later.'
    );
  }
  const namespace = serviceJournalNamespace(config);
  const opened = await openOperationJournal(adapter, namespace, config.key).catch(() => undefined);
  if (opened?.kind !== 'opened') {
    await adapter.dispose().catch(() => undefined);
    const reason = opened === undefined ? 'error' : `${opened.kind}: ${opened.reason}`;
    throw new JournalConfigError(
      `The durable journal did not open (${reason}). An uninitialized store needs AGENTBROWSER_JOURNAL_INITIALIZE=1 once; "configuration" means this namespace exists with a different key, horizon, restore generation or bounds (configure a new AGENTBROWSER_JOURNAL_NAMESPACE instead of changing them), or the wall clock is behind the store's recorded time; "ownership" means another process holds it; a refused layout follows docs/spec/design/t5-operator-reconciliation.md`
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
