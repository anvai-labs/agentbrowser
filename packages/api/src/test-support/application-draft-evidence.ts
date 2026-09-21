import { canonicalJson } from '@agentbrowser/core';
import { VERIFICATION_SNAPSHOT_LIMITS, snapshotJsonData } from '@agentbrowser/protocol';
import type { DraftSnapshot } from './application-draft.js';

type DraftIdentity = Pick<
  DraftSnapshot,
  'id' | 'incarnation' | 'version' | 'job' | 'destination' | 'intent'
>;
const identityKeys = ['id', 'incarnation', 'version', 'job', 'destination', 'intent'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function requireData(condition: unknown): asserts condition {
  if (!condition) throw new Error('Draft evidence unavailable');
}
function snapshot(value: unknown): unknown {
  return JSON.parse(canonicalJson(snapshotJsonData(value, VERIFICATION_SNAPSHOT_LIMITS)));
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireData(value !== null && typeof value === 'object' && !Array.isArray(value));
  const object = value as Record<string, unknown>;
  requireData(
    Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key))
  );
  return object;
}
function text(value: unknown, max = 256): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    [...value].every((character) => character.charCodeAt(0) >= 32)
  );
}
function identity(value: Record<string, unknown>): void {
  requireData(typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.id));
  requireData(typeof value.incarnation === 'string' && uuid.test(value.incarnation));
  requireData(Number.isSafeInteger(value.version) && Number(value.version) >= 0);
  const job = exact(value.job, ['id', 'company']);
  requireData(job.id === 'synthetic-platform-role' && job.company === 'Synthetic Company');
  requireData(value.destination === 'https://example.test/apply' && value.intent === 'draft');
}

/** Test-only data qualification. Does not attest page identity, freshness or submission. */
export function createDraftDataQualifier(
  expected: DraftIdentity
): (input: unknown) => DraftSnapshot {
  try {
    const pinned = exact(snapshot(expected), identityKeys);
    identity(pinned);
    const pinnedIdentity = canonicalJson(pinned);
    return (input) => {
      try {
        const value = exact(snapshot(input), [
          ...identityKeys,
          'contract',
          'fields',
          'attachment',
          'complete',
          'missing',
        ]);
        identity(value);
        const observedIdentity = Object.fromEntries(identityKeys.map((key) => [key, value[key]]));
        requireData(canonicalJson(observedIdentity) === pinnedIdentity);
        const contract = exact(value.contract, ['id', 'version']);
        requireData(contract.id === 'synthetic-application-draft' && contract.version === 1);
        const fields = exact(value.fields, [
          'fullName',
          'currentCompany',
          'previousCompany',
          'preference',
          'relocation',
          'referral',
          'terms',
          'source',
        ]);
        for (const key of ['fullName', 'currentCompany', 'previousCompany']) {
          const answer = fields[key];
          requireData(text(answer) && answer.trim().length > 0);
        }
        requireData(text(fields.referral));
        requireData(fields.preference === 'remote' || fields.preference === 'hybrid');
        requireData(
          typeof fields.relocation === 'boolean' ||
            (fields.preference === 'remote' && fields.relocation === null)
        );
        requireData(fields.terms === true && fields.source === 'direct');
        const attachment = exact(value.attachment, ['id', 'name', 'type', 'size', 'sha256']);
        requireData(typeof attachment.id === 'string' && uuid.test(attachment.id));
        requireData(
          text(attachment.name, 128) &&
            attachment.name.length > 0 &&
            attachment.name.trim() === attachment.name &&
            !/[\\/]/.test(attachment.name)
        );
        requireData(
          attachment.type === 'application/pdf' &&
            Number.isSafeInteger(attachment.size) &&
            Number(attachment.size) > 0 &&
            Number(attachment.size) <= 32 * 1024
        );
        requireData(
          typeof attachment.sha256 === 'string' && /^[0-9a-f]{64}$/.test(attachment.sha256)
        );
        // Completeness was derived above; these owner assertions must agree, not replace it.
        requireData(
          value.complete === true && Array.isArray(value.missing) && value.missing.length === 0
        );
        return value as unknown as DraftSnapshot;
      } catch {
        throw new Error('Draft evidence unavailable');
      }
    };
  } catch {
    throw new Error('Draft evidence unavailable');
  }
}
