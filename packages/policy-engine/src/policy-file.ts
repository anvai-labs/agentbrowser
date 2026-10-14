import { readFile } from 'node:fs/promises';
import type { PolicyDocument, PolicyLimits } from '@agentbrowser/protocol';
import { parsePolicyDocument } from '@agentbrowser/protocol';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import { CedarAuthorizer } from './cedar-authorizer.js';

/**
 * TD-BROWSER-15 phase 4: load a policy file into a `CedarAuthorizer`, refusing
 * everything the TD refuses at startup rather than ignoring it:
 *
 * - a structurally invalid document, or one Cedar validation or the trap rules
 *   refuse (that is `CedarAuthorizer`'s own constructor);
 * - a file combined with any policy-bearing environment variable — all
 *   conflicts are named, so an operator sees the whole picture at once;
 * - an unknown `limits` key (the schema refuses it; this reports the path);
 * - while no API keys are configured, any `Tenant` literal other than
 *   `local` anywhere in any policy, conditions included — found by walking
 *   `policyToJson`, so no spelling of a tenant can slip through;
 * - an API key tenant named `local` (the name is reserved for the no-keys
 *   implicit tenant).
 *
 * The loaded authorizer's version is the document's SHA-256 (baseline
 * included); sessions stamp it.
 */

export interface PolicyFileOptions {
  /** True when AGENTBROWSER_API_KEYS configures tenants. */
  apiKeysConfigured: boolean;
  /** The key tenants, when configured; `local` among them is a refusal. */
  keyTenants?: readonly string[];
}

export interface LoadedPolicy {
  readonly authorizer: CedarAuthorizer;
  readonly document: PolicyDocument;
  readonly limits: PolicyLimits;
}

const POLICY_BEARING_ENV = [
  'AGENTBROWSER_ALLOW_LOOPBACK',
  'AGENTBROWSER_ALLOWED_CIDRS',
  'AGENTBROWSER_APPROVAL_POLICY',
  'AGENTBROWSER_MAX_RESPONSE_BYTES',
] as const;

export class PolicyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyFileError';
  }
}

/** Reads, parses and loads the document at `path`, applying every refusal. */
export async function loadPolicyFile(
  path: string,
  options: PolicyFileOptions,
  env: Record<string, string | undefined> = process.env
): Promise<LoadedPolicy> {
  const conflicts = POLICY_BEARING_ENV.filter((name) => env[name] !== undefined);
  if (conflicts.length > 0) {
    throw new PolicyFileError(
      `AGENTBROWSER_POLICY_FILE cannot be combined with policy-bearing variables: ${conflicts.join(', ')}`
    );
  }
  if (options.keyTenants?.includes('local')) {
    throw new PolicyFileError(
      'the tenant name "local" is reserved for the no-keys implicit tenant'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new PolicyFileError(`cannot read or parse the policy file: ${(error as Error).message}`);
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const limits = (parsed as { limits?: unknown }).limits;
    if (
      limits !== undefined &&
      (typeof limits !== 'object' || limits === null || Array.isArray(limits))
    ) {
      throw new PolicyFileError('Invalid policy document: /limits must be an object');
    }
  }
  const document = parsePolicyDocument(parsed);

  if (!options.apiKeysConfigured) {
    const foreign = foreignTenantLiterals(document);
    if (foreign.length > 0) {
      throw new PolicyFileError(
        `the policy names tenants ${[...new Set(foreign)]
          .sort()
          .map((t) => JSON.stringify(t))
          .join(', ')} but no API keys are configured; only Tenant::"local" exists without keys`
      );
    }
  }

  const authorizer = new CedarAuthorizer({ document });
  return { authorizer, document, limits: document.limits ?? {} };
}

/**
 * Every `Tenant::"…"` literal in the document, by walking the parsed policy
 * ASTs — principals, resources and conditions included. Only non-`local`
 * names are returned.
 */
function foreignTenantLiterals(document: PolicyDocument): string[] {
  const found: string[] = [];
  // Entity literals appear as {type, id} in the scope and as {__entity:{type,
  // id}} inside expressions; one recursive walk covers both spellings.
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.type === 'AgentBrowser::Tenant' && typeof record.id === 'string') {
      if (record.id !== 'local') found.push(record.id);
    }
    for (const child of Object.values(record)) walk(child);
  };
  for (const policy of document.policies) {
    const json = cedar.policyToJson(policy.cedar);
    if (json.type !== 'success') continue; // the authorizer refuses unparseable text separately
    walk(json.json);
  }
  return found;
}
