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
 * - `AGENTBROWSER_JOURNAL_HISTORY_FILE` (optional, T5 J3d / D7): an owner-only JSON file listing
 *   namespaces the operator rotated away from, each with EVERY descriptor input (recorded, never
 *   read from the running release) and its original key file, so lookup and the operator's
 *   close/settle/reconcile still reach their records until `retainUntil`.
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
  type JournalRecord,
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

async function readKeyFile(
  path: string,
  label = 'AGENTBROWSER_JOURNAL_KEY_FILE'
): Promise<{ keyId: string; key: Uint8Array }> {
  const invalid = (detail: string) => new JournalConfigError(`Invalid ${label}: ${detail}`);
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
  const set = await openServiceJournalSet(config, [], options);
  if (!set.journal) {
    await set.close();
    throw new JournalConfigError('The durable journal did not open');
  }
  return { journal: set.journal, close: set.close };
}

/** One namespace this process rotated away from, as the operator recorded it (D7). */
export interface ServiceJournalHistoryEntry {
  readonly namespaceId: string;
  readonly acceptUntil: number;
  readonly retainMs: number;
  readonly finalizationMs: number;
  readonly restoreGeneration: string;
  readonly maxRecords: number;
  readonly bounds: {
    readonly maxRecordBytes: number;
    readonly maxNamespaces: number;
    readonly maxInFlight: number;
    readonly timeoutMs: number;
  };
  readonly keyId: string;
  readonly key: Uint8Array;
}

export interface ServiceJournalHistoryState {
  readonly namespaceId: string;
  /** True for the CURRENT namespace once its accept horizon has passed (opened recover-only). */
  readonly current?: boolean;
  readonly acceptUntil: number;
  readonly retainUntil: number;
  /** The open handle; undefined when the store refused the namespace (see `refusal`). */
  readonly journal?: OperationJournal;
  /** Why the namespace did not open, e.g. `definitely_not_opened: expired` or `...: configuration`. */
  readonly refusal?: string;
}

export interface ServiceJournalSet {
  /** The current namespace's journal; undefined once its accept horizon has passed. */
  readonly journal?: OperationJournal;
  readonly history: readonly ServiceJournalHistoryState[];
  close(): Promise<void>;
}

/** Rebuilds a history namespace's exact original descriptor from its recorded entry. */
export function historyJournalNamespace(entry: ServiceJournalHistoryEntry): JournalNamespace {
  return {
    schemaVersion: 1,
    namespaceId: entry.namespaceId,
    fingerprintVersion: 1,
    fingerprintKeyId: entry.keyId,
    restoreGeneration: entry.restoreGeneration,
    acceptUntil: entry.acceptUntil,
    retainUntil: entry.acceptUntil + entry.retainMs,
    maxFinalizationMs: entry.finalizationMs,
    bounds: { ...entry.bounds, maxRecords: entry.maxRecords },
  };
}

/**
 * The history entry an operator records for the CURRENT namespace before rotating away from it:
 * every descriptor input except the key, plus the place for the key file path. Non-secret.
 */
export function serviceJournalHistoryTemplate(config: ServiceJournalConfig) {
  return {
    namespace: config.namespaceId,
    acceptUntil: new Date(config.acceptUntil).toISOString(),
    restoreGeneration: config.restoreGeneration,
    maxRecords: config.maxRecords,
    retainMs: SERVICE_JOURNAL_RETAIN_MS,
    finalizationMs: SERVICE_JOURNAL_FINALIZATION_MS,
    bounds: { ...SERVICE_JOURNAL_BOUNDS },
    keyFile: '<absolute path to the key file this namespace was created with>',
  };
}

/**
 * Opens the store once and, on that one adapter (the store admits one server), the current
 * namespace (while its horizon has not passed) and every history namespace. A history namespace
 * the store refuses is reported, never fatal: a typo in history must not take durable writes away
 * from the current namespace. A refusal of the CURRENT namespace aborts startup as before.
 */
export async function openServiceJournalSet(
  config: ServiceJournalConfig,
  history: readonly ServiceJournalHistoryEntry[],
  options: { now?: () => number } = {}
): Promise<ServiceJournalSet> {
  const now = options.now ?? Date.now;
  const currentOpen = config.acceptUntil > now();
  const currentDescriptor = serviceJournalNamespace(config);
  let adapter: Awaited<ReturnType<typeof openJournalSqliteOperationJournalAdapter>>;
  try {
    adapter = await openJournalSqliteOperationJournalAdapter({
      directory: config.directory,
      anchorDirectory: config.anchorDirectory,
      restoreGeneration: config.restoreGeneration,
      initialize: config.initialize,
    });
  } catch {
    // A past-horizon namespace with no history never ABORTED startup (durable work is simply
    // refused); keep that, but report it as configured-and-unread rather than silent.
    if (!currentOpen && history.length === 0)
      return {
        history: [
          {
            namespaceId: config.namespaceId,
            current: true,
            acceptUntil: currentDescriptor.acceptUntil,
            retainUntil: currentDescriptor.retainUntil,
            refusal: 'store did not start',
          },
        ],
        close: async () => {},
      };
    throw new JournalConfigError(
      'The durable journal store did not start: another process may hold it (one server per store), or AGENTBROWSER_JOURNAL_DIR / AGENTBROWSER_JOURNAL_ANCHOR_DIR or the store layout is refused (docs/spec/design/t5-operator-reconciliation.md). The journal needs Node 22.13 or later.'
    );
  }
  const opened: OperationJournal[] = [];
  const closeAll = async () => {
    for (const journal of opened) await journal.close().catch(() => undefined);
    await adapter.dispose().catch(() => undefined);
  };
  let journal: OperationJournal | undefined;
  if (currentOpen) {
    const current = await openOperationJournal(
      adapter,
      serviceJournalNamespace(config),
      config.key
    ).catch(() => undefined);
    if (current?.kind !== 'opened') {
      await closeAll();
      const reason = current === undefined ? 'error' : `${current.kind}: ${current.reason}`;
      throw new JournalConfigError(
        `The durable journal did not open (${reason}). An uninitialized store needs AGENTBROWSER_JOURNAL_INITIALIZE=1 once; "configuration" means this namespace exists with a different key, horizon, restore generation or bounds (configure a new AGENTBROWSER_JOURNAL_NAMESPACE instead of changing them), or the wall clock is behind the store's recorded time; "ownership" means another process holds it; a refused layout follows docs/spec/design/t5-operator-reconciliation.md`
      );
    }
    journal = current.journal;
    opened.push(journal);
  }
  const states: ServiceJournalHistoryState[] = [];
  // Review F1: a CURRENT namespace past its horizon is still inside retention, so its records
  // must stay reachable (and recoverable) like any history namespace — opened recover-only and
  // searched, or reported unread when the store refuses it. Never silently left out.
  if (!currentOpen) {
    const past = await openOperationJournal(adapter, currentDescriptor, config.key).catch(
      () => undefined
    );
    const base = {
      namespaceId: config.namespaceId,
      current: true,
      acceptUntil: currentDescriptor.acceptUntil,
      retainUntil: currentDescriptor.retainUntil,
    };
    if (past?.kind === 'opened') {
      opened.push(past.journal);
      states.push({ ...base, journal: recoverOnly(past.journal) });
    } else {
      states.push({
        ...base,
        refusal: past === undefined ? 'error' : `${past.kind}: ${past.reason}`,
      });
    }
  }
  for (const entry of history) {
    const namespace = historyJournalNamespace(entry);
    const base = {
      namespaceId: entry.namespaceId,
      acceptUntil: namespace.acceptUntil,
      retainUntil: namespace.retainUntil,
    };
    // A history entry opens only once its accept horizon has passed: the store CREATES a missing
    // namespace whose horizon is still ahead, so a typo'd name listed early would silently take a
    // store slot. Past the horizon the store refuses to create one. An entry listed too early is
    // reported (and its records read as unread), never opened.
    if (namespace.acceptUntil > now()) {
      states.push({
        ...base,
        refusal: 'not yet past its accept horizon: list it once its ACCEPT_UNTIL has passed',
      });
      continue;
    }
    const result = await openOperationJournal(adapter, namespace, entry.key).catch(() => undefined);
    if (result?.kind === 'opened') {
      opened.push(result.journal);
      states.push({ ...base, journal: recoverOnly(result.journal) });
    } else {
      states.push({
        ...base,
        refusal: result === undefined ? 'error' : `${result.kind}: ${result.reason}`,
      });
    }
  }
  let closing: Promise<void> | undefined;
  return {
    ...(journal ? { journal } : {}),
    history: states,
    close: () => {
      closing ??= closeAll();
      return closing;
    },
  };
}

const HISTORY_ENTRY_KEYS = [
  'namespace',
  'acceptUntil',
  'keyFile',
  'restoreGeneration',
  'maxRecords',
  'retainMs',
  'finalizationMs',
  'bounds',
].sort();
const BOUNDS_KEYS = ['maxInFlight', 'maxNamespaces', 'maxRecordBytes', 'timeoutMs'];

/**
 * Reads `AGENTBROWSER_JOURNAL_HISTORY_FILE`: `[]` when unset. The file is owner-only JSON
 * `{"schemaVersion":1,"namespaces":[entry,...]}` (at most 16), every entry strict. A history
 * namespace can never be the current one, and names are unique. Errors name positions, never
 * key material.
 */
export async function journalHistoryFromEnvironment(
  env: JournalEnvironment = process.env,
  current?: ServiceJournalConfig
): Promise<ServiceJournalHistoryEntry[]> {
  const path = env.AGENTBROWSER_JOURNAL_HISTORY_FILE?.trim();
  if (path === undefined || path === '') return [];
  const invalid = (detail: string) =>
    new JournalConfigError(`Invalid AGENTBROWSER_JOURNAL_HISTORY_FILE: ${detail}`);
  if (!isAbsolute(path)) throw invalid('the path must be absolute');
  let text: string;
  try {
    const info = await stat(path);
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      throw invalid('the file must be readable by its owner only (chmod 600)');
    if (info.size > 65_536) throw invalid('the file is larger than 64 KiB');
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof JournalConfigError) throw error;
    throw invalid('the file cannot be read');
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw invalid('the file is not JSON');
  }
  const plain = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  if (!plain(document) || !exactKeys(document, ['schemaVersion', 'namespaces']))
    throw invalid('expected {"schemaVersion":1,"namespaces":[...]}');
  if (document.schemaVersion !== 1) throw invalid('schemaVersion must be 1');
  const list = document.namespaces;
  if (!Array.isArray(list) || list.length > 16)
    throw invalid('namespaces must be an array of at most 16 entries');
  const entries: ServiceJournalHistoryEntry[] = [];
  const seen = new Set<string>(current ? [current.namespaceId] : []);
  for (const [index, raw] of list.entries()) {
    const at = (detail: string) => invalid(`namespaces[${index}]: ${detail}`);
    if (!plain(raw) || !exactKeys(raw, HISTORY_ENTRY_KEYS))
      throw at(`expected exactly ${HISTORY_ENTRY_KEYS.join(', ')}`);
    const name = raw.namespace;
    if (typeof name !== 'string' || !IDENTIFIER.test(name))
      throw at('namespace must be 1-128 letters, digits, "_" or "-"');
    if (seen.has(name)) throw at('the namespace is the current one or is listed twice');
    seen.add(name);
    const acceptUntil =
      typeof raw.acceptUntil === 'string' && ISO_INSTANT.test(raw.acceptUntil)
        ? Date.parse(raw.acceptUntil)
        : Number.NaN;
    if (!Number.isSafeInteger(acceptUntil) || acceptUntil <= 0)
      throw at('acceptUntil must be an ISO-8601 instant with a time zone');
    if (typeof raw.restoreGeneration !== 'string' || !IDENTIFIER.test(raw.restoreGeneration))
      throw at('restoreGeneration must be 1-128 letters, digits, "_" or "-"');
    const positive = (value: unknown, max: number) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
    if (!positive(raw.maxRecords, 1_000_000))
      throw at('maxRecords must be an integer from 1 to 1000000');
    if (!positive(raw.retainMs, Number.MAX_SAFE_INTEGER))
      throw at('retainMs must be a positive integer');
    if (!positive(raw.finalizationMs, Number.MAX_SAFE_INTEGER))
      throw at('finalizationMs must be a positive integer');
    const bounds = raw.bounds;
    if (
      !plain(bounds) ||
      !exactKeys(bounds, BOUNDS_KEYS) ||
      !BOUNDS_KEYS.every((key) => positive(bounds[key], Number.MAX_SAFE_INTEGER))
    )
      throw at(`bounds must hold exactly ${BOUNDS_KEYS.join(', ')} as positive integers`);
    if (typeof raw.keyFile !== 'string' || !isAbsolute(raw.keyFile))
      throw at('keyFile must be an absolute path');
    const { keyId, key } = await readKeyFile(
      raw.keyFile,
      `AGENTBROWSER_JOURNAL_HISTORY_FILE namespaces[${index}].keyFile`
    );
    entries.push({
      namespaceId: name,
      acceptUntil,
      retainMs: raw.retainMs as number,
      finalizationMs: raw.finalizationMs as number,
      restoreGeneration: raw.restoreGeneration,
      maxRecords: raw.maxRecords as number,
      bounds: {
        maxRecordBytes: bounds.maxRecordBytes as number,
        maxNamespaces: bounds.maxNamespaces as number,
        maxInFlight: bounds.maxInFlight as number,
        timeoutMs: bounds.timeoutMs as number,
      },
      keyId,
      key,
    });
  }
  return entries;
}

/**
 * J3d: one bounded search across the current and history namespaces. Each record keeps the
 * journal that returned it (recovery writes commit to their owner). A namespace that cannot be
 * read is named in `unreadNamespaces`, so callers never mistake partial history for absence. The
 * page bound (16) holds across namespaces; `truncated` reports more.
 */
export async function searchJournalNamespaces(
  journals: readonly OperationJournal[],
  query: { tenantId: string; operationId: string; actionableOnly?: boolean }
): Promise<{
  entries: Array<{ record: JournalRecord; journal: OperationJournal }>;
  truncated: boolean;
  unreadNamespaces: string[];
  lastReason: string;
}> {
  const entries: Array<{ record: JournalRecord; journal: OperationJournal }> = [];
  const unreadNamespaces: string[] = [];
  let truncated = false;
  let lastReason = 'unavailable';
  for (const journal of journals) {
    if (journal.health !== 'open') {
      unreadNamespaces.push(journal.namespace.namespaceId);
      lastReason = journal.health;
      continue;
    }
    let outcome: Awaited<ReturnType<OperationJournal['findByOperation']>>;
    try {
      outcome = await journal.findByOperation({
        tenantId: query.tenantId,
        operationId: query.operationId,
        limit: 16,
        ...(query.actionableOnly ? { actionableOnly: true } : {}),
      });
    } catch {
      unreadNamespaces.push(journal.namespace.namespaceId);
      lastReason = 'error';
      continue;
    }
    if (outcome.kind !== 'found') {
      lastReason =
        outcome.kind === 'definitely_not_read' || outcome.kind === 'uncertain'
          ? outcome.reason
          : 'unavailable';
      unreadNamespaces.push(journal.namespace.namespaceId);
      continue;
    }
    for (const record of outcome.records) entries.push({ record, journal });
    truncated ||= outcome.truncated;
  }
  if (entries.length > 16) {
    entries.length = 16;
    truncated = true;
  }
  return { entries, truncated, unreadNamespaces, lastReason };
}

/**
 * J3d review F2: a history (or past-horizon) namespace is recover-only. The store's admission
 * gate is time-based, so a history entry listed BEFORE its horizon passed would admit an intent;
 * this wrapper refuses new intents and dispatch marks without touching the store. Lookup and the
 * operator's terminal commits (D2/D3) pass through.
 */
export function recoverOnly(journal: OperationJournal): OperationJournal {
  const refused = (): ReturnType<OperationJournal['reserveIntent']> => {
    const call = Promise.resolve({
      kind: 'definitely_not_written' as const,
      reason: 'admission_expired' as const,
    });
    return Object.assign(call, { settled: Promise.resolve() });
  };
  return {
    get namespace() {
      return journal.namespace;
    },
    get health() {
      return journal.health;
    },
    get pending() {
      return journal.pending;
    },
    reserveIntent: () => refused(),
    markDispatch: () => refused(),
    commitTerminal: (transition, signal) => journal.commitTerminal(transition, signal),
    lookup: (key, signal) => journal.lookup(key, signal),
    findByOperation: (query, signal) => journal.findByOperation(query, signal),
    close: () => journal.close(),
  };
}

/** J3d: startup warnings for history namespaces (refused, or open within 7 days of retainUntil). */
export function journalHistoryWarnings(
  states: readonly ServiceJournalHistoryState[],
  now: number = Date.now()
): string[] {
  const warnings: string[] = [];
  for (const state of states) {
    if (state.refusal !== undefined)
      warnings.push(
        `journal history namespace ${state.namespaceId} did not open (${state.refusal}); its records are unread until the entry is corrected (remove an entry once it is past retainUntil)`
      );
    else if (state.retainUntil - now < 7 * 24 * 60 * 60 * 1000)
      warnings.push(
        `journal history namespace ${state.namespaceId} reaches retainUntil at ${new Date(state.retainUntil).toISOString()}: close, reconcile or settle its actionable records before then — after it they can never be closed`
      );
  }
  return warnings;
}
