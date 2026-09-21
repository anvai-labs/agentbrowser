import { createHash, randomUUID } from 'node:crypto';
import {
  type ApplicationAdapter,
  type ApplicationResult,
  type ApplicationScope,
  defineApplicationOperation,
} from '@agentbrowser/control';
import { ControlError, canonicalJson } from '@agentbrowser/core';

/** Common fixture limit leaves room for canonical base64 inside the existing JSON envelope. */
export const DRAFT_UPLOAD_MAX_BYTES = 32 * 1024;
export interface DraftFields {
  fullName: string;
  currentCompany: string;
  previousCompany: string;
  preference: '' | 'remote' | 'hybrid';
  relocation: boolean | null;
  referral: string;
  terms: boolean;
  source: 'direct';
}
export interface DraftSnapshot {
  contract: { id: 'synthetic-application-draft'; version: 1 };
  id: string;
  incarnation: string;
  version: number;
  job: { id: string; company: string };
  destination: string;
  intent: 'draft';
  fields: DraftFields;
  attachment: null | { id: string; name: string; type: string; size: number; sha256: string };
  complete: boolean;
  missing: string[];
}
type Patch = Partial<Omit<DraftFields, 'source'>>;
type Upload = { name: string; type: string; bytes: Uint8Array };

function invalid(): never {
  throw new ControlError('INVALID_REQUEST', 'Invalid draft input');
}
function jsonObject(input: unknown): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(canonicalJson(input));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    return value as Record<string, unknown>;
  } catch {
    return invalid();
  }
}
function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required = allowed
): void {
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}
function parsePatch(input: unknown): Patch {
  const patch = jsonObject(input);
  exactKeys(
    patch,
    [
      'fullName',
      'currentCompany',
      'previousCompany',
      'preference',
      'relocation',
      'referral',
      'terms',
    ],
    []
  );
  if (Object.keys(patch).length === 0) invalid();
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'preference') {
      if (value !== '' && value !== 'remote' && value !== 'hybrid') invalid();
    } else if (key === 'relocation') {
      if (value !== null && typeof value !== 'boolean') invalid();
    } else if (key === 'terms') {
      if (typeof value !== 'boolean') invalid();
    } else if (typeof value !== 'string' || value.length > 256 || hasControlCharacter(value))
      invalid();
  }
  return patch as Patch;
}
const hasControlCharacter = (text: string) =>
  [...text].some((character) => character.charCodeAt(0) < 32);
function metadata(input: Record<string, unknown>): { name: string; type: string } {
  if (
    typeof input.name !== 'string' ||
    input.name.length < 1 ||
    input.name.length > 128 ||
    input.name.includes('/') ||
    input.name.includes('\\') ||
    hasControlCharacter(input.name) ||
    input.name.trim() !== input.name ||
    input.type !== 'application/pdf'
  )
    invalid();
  return { name: input.name, type: input.type };
}
function parseUpload(input: unknown): Upload {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype)
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).length !== 3 ||
    !['name', 'type', 'bytes'].every(
      (key) => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value')
    )
  )
    invalid();
  const meta = metadata({ name: descriptors.name?.value, type: descriptors.type?.value });
  const bytes: unknown = descriptors.bytes?.value;
  if (
    !(bytes instanceof Uint8Array) ||
    (Object.getPrototypeOf(bytes) !== Uint8Array.prototype &&
      Object.getPrototypeOf(bytes) !== Buffer.prototype)
  )
    invalid();
  // Intrinsic accessors avoid user-defined getters. Reject shared backing memory;
  // a detached copy is then stable for hashing and the synchronous commit.
  const prototype = Object.getPrototypeOf(Uint8Array.prototype);
  const length = Object.getOwnPropertyDescriptor(prototype, 'byteLength')?.get?.call(
    bytes
  ) as number;
  const offset = Object.getOwnPropertyDescriptor(prototype, 'byteOffset')?.get?.call(
    bytes
  ) as number;
  const backing = Object.getOwnPropertyDescriptor(prototype, 'buffer')?.get?.call(
    bytes
  ) as ArrayBuffer;
  if (!(backing instanceof ArrayBuffer) || length < 1 || length > DRAFT_UPLOAD_MAX_BYTES) invalid();
  return { ...meta, bytes: Buffer.from(Buffer.from(backing, offset, length)) };
}
function parseBase64(input: unknown): Upload {
  const value = jsonObject(input);
  exactKeys(value, ['name', 'type', 'base64']);
  const meta = metadata(value);
  if (
    typeof value.base64 !== 'string' ||
    value.base64.length > Math.ceil(DRAFT_UPLOAD_MAX_BYTES / 3) * 4
  )
    invalid();
  const bytes = Buffer.from(value.base64, 'base64');
  if (
    bytes.toString('base64') !== value.base64 ||
    bytes.length < 1 ||
    bytes.length > DRAFT_UPLOAD_MAX_BYTES
  )
    invalid();
  return { ...meta, bytes };
}
function empty(input: unknown): void {
  exactKeys(jsonObject(input), []);
}

/** Independent synthetic business state; no browser, executor or operation ledger. */
export function createApplicationDraft(options: {
  id: string;
  tenant?: string;
  resource?: string;
}) {
  const config = jsonObject(options);
  exactKeys(config, ['id', 'tenant', 'resource'], ['id']);
  for (const value of Object.values(config))
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) invalid();
  const id = config.id as string;
  const tenant = (config.tenant as string | undefined) ?? 'owner';
  const resource = (config.resource as string | undefined) ?? id;
  const incarnation = randomUUID();
  let version = 0;
  let fields: DraftFields = {
    fullName: '',
    currentCompany: '',
    previousCompany: '',
    preference: '',
    relocation: null,
    referral: '',
    terms: false,
    source: 'direct',
  };
  let attachment: DraftSnapshot['attachment'] = null;
  const read = (): DraftSnapshot => {
    const missing: string[] = [];
    for (const key of ['fullName', 'currentCompany', 'previousCompany', 'preference'] as const)
      if (!fields[key].trim()) missing.push(key);
    if (fields.preference === 'hybrid' && fields.relocation === null) missing.push('relocation');
    if (!fields.terms) missing.push('terms');
    if (!attachment) missing.push('attachment');
    return {
      contract: { id: 'synthetic-application-draft', version: 1 },
      id,
      incarnation,
      version,
      job: { id: 'synthetic-platform-role', company: 'Synthetic Company' },
      destination: 'https://example.test/apply',
      intent: 'draft',
      fields: { ...fields },
      attachment: attachment ? { ...attachment } : null,
      complete: missing.length === 0,
      missing,
    };
  };
  const checkVersion = (expectedVersion: unknown) => {
    if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0) invalid();
    if (expectedVersion !== version) throw new Error('VERSION_CONFLICT');
    if (version === Number.MAX_SAFE_INTEGER) invalid();
  };
  const update = (expectedVersion: number, input: unknown): DraftSnapshot => {
    const patch = parsePatch(input);
    checkVersion(expectedVersion);
    fields = { ...fields, ...patch };
    version++;
    return read();
  };
  const upload = (expectedVersion: number, input: unknown): DraftSnapshot => {
    const file = parseUpload(input);
    checkVersion(expectedVersion);
    attachment = {
      id: randomUUID(),
      name: file.name,
      type: file.type,
      size: file.bytes.byteLength,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    };
    version++;
    return read();
  };
  const remove = (expectedVersion: number): DraftSnapshot => {
    checkVersion(expectedVersion);
    attachment = null;
    version++;
    return read();
  };
  const commit = (
    scope: ApplicationScope,
    effect: () => DraftSnapshot
  ): ApplicationResult<DraftSnapshot> => {
    if (scope.signal.aborted || scope.tenant !== tenant || scope.resource !== resource)
      return { status: 'rejected', reason: 'INVALID_SCOPE' };
    try {
      return { status: 'committed', value: effect() };
    } catch (error) {
      if (error instanceof Error && error.message === 'VERSION_CONFLICT')
        return { status: 'rejected', reason: 'VERSION_CONFLICT' };
      throw error;
    }
  };
  const adapter: ApplicationAdapter = {
    id: `application-draft-${id}`,
    authorize: (scope) => scope.tenant === tenant && scope.resource === resource,
    operations: {
      read: defineApplicationOperation({
        mode: 'read',
        parse: empty,
        execute: async (_input, scope) =>
          scope.signal.aborted || scope.tenant !== tenant || scope.resource !== resource
            ? { status: 'rejected', reason: 'INVALID_SCOPE' }
            : { status: 'read', value: read() },
      }),
      update: defineApplicationOperation({
        mode: 'write',
        parse: parsePatch,
        execute: async (patch, scope) =>
          commit(scope, () => update(scope.expectedVersion as number, patch)),
      }),
      upload: defineApplicationOperation({
        mode: 'write',
        parse: parseBase64,
        execute: async (file, scope) =>
          commit(scope, () => upload(scope.expectedVersion as number, file)),
      }),
      remove: defineApplicationOperation({
        mode: 'write',
        parse: empty,
        execute: async (_input, scope) =>
          commit(scope, () => remove(scope.expectedVersion as number)),
      }),
    },
    receipt: async () => null,
  };
  return { read, update, upload, remove, adapter };
}
