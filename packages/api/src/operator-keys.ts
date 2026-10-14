import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * TD-BROWSER-16 phase 1 (ADR-025): operator keys from a file, never a
 * variable. `AGENTBROWSER_OPERATOR_KEYS_FILE` holds `key:tenant` lines.
 *
 * - Every tenant must equal the single API-key tenant (an operator key never
 *   widens who exists on this deployment; it authenticates a human for the
 *   one tenant already configured).
 * - A key appearing in both the operator file and the API keys aborts
 *   startup: one credential, one identity.
 * - Keys are SHA-256-hashed like API keys and never logged; errors name
 *   positions, never values.
 */

export class OperatorKeysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorKeysError';
  }
}

export interface OperatorKeys {
  /** SHA-256(key) → tenant. */
  readonly byHash: ReadonlyMap<string, string>;
  readonly tenant: string;
}

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/;

export async function operatorKeysFromEnvironment(
  env: { AGENTBROWSER_OPERATOR_KEYS_FILE?: string | undefined } = process.env
): Promise<OperatorKeys | undefined> {
  const path = env.AGENTBROWSER_OPERATOR_KEYS_FILE?.trim();
  if (path === undefined || path === '') return undefined;
  return operatorKeysFromFile(path);
}

export async function operatorKeysFromFile(
  path: string,
  options: { apiKeys?: ReadonlyMap<string, string> } = {}
): Promise<OperatorKeys> {
  const text = await readFile(path, 'utf8');
  const byHash = new Map<string, string>();
  let tenant: string | undefined;
  let count = 0;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.lastIndexOf(':');
    if (at <= 0 || at === line.length - 1) {
      throw new OperatorKeysError(
        `Invalid operator keys file: line ${index + 1} must be key:tenant`
      );
    }
    const key = line.slice(0, at);
    const entryTenant = line.slice(at + 1);
    if (!KEY_ID.test(key)) {
      throw new OperatorKeysError(
        `Invalid operator keys file: line ${index + 1} key must be 16-128 characters of letters, digits, ".", "_" or "-"`
      );
    }
    if (tenant === undefined) tenant = entryTenant;
    else if (tenant !== entryTenant) {
      throw new OperatorKeysError(
        `Invalid operator keys file: line ${index + 1} names tenant ${JSON.stringify(entryTenant)} but an earlier line names ${JSON.stringify(tenant)}; every operator key must map to the single configured tenant`
      );
    }
    const hash = createHash('sha256').update(key).digest('hex');
    if (byHash.has(hash)) {
      throw new OperatorKeysError(`Invalid operator keys file: line ${index + 1} duplicates a key`);
    }
    byHash.set(hash, entryTenant);
    count += 1;
  }
  if (count === 0) {
    throw new OperatorKeysError('Invalid operator keys file: no key:tenant entries');
  }
  if (options.apiKeys !== undefined) {
    for (const hash of byHash.keys()) {
      if (options.apiKeys.has(hash)) {
        throw new OperatorKeysError(
          'Invalid configuration: a key appears in both AGENTBROWSER_API_KEYS and the operator keys file; one credential, one identity'
        );
      }
    }
    const apiTenants = new Set(options.apiKeys.values());
    if (apiTenants.size > 0 && !apiTenants.has(tenant as string)) {
      throw new OperatorKeysError(
        `Invalid operator keys file: tenant ${JSON.stringify(tenant)} is not the API-key tenant; operator keys serve the one configured tenant`
      );
    }
  }
  return { byHash, tenant: tenant as string };
}
