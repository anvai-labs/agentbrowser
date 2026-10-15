import { VisualAuditError } from './visual-audit.js';

/** T7 acceptance: "Confirmed findings include independent evidence and cleanup; suspected
 * findings remain labeled." A finding moves from `suspected` to `confirmed` only here, and only
 * with evidence that does not come from the tool that raised it: a reproduction the auditor
 * performed independently. A scanner's own confidence is never accepted as confirmation. */

export interface ConfirmationCleanup {
  /** Whether the reproduction created state that must be removed. */
  required: boolean;
  /** Whether that state was removed. A required, unperformed cleanup refuses confirmation. */
  performed: boolean;
  /** What was (or did not need to be) cleaned up. */
  note: string;
}

export interface ConfirmationEvidence {
  method: 'independent-reproduction';
  /** ISO-8601 time of the reproduction. */
  reproducedAt: string;
  /** What the reproduction observed — a bounded description, never the private payload itself. */
  observation: string;
  cleanup: ConfirmationCleanup;
}

export type Confirmed<T> = Omit<T, 'status'> & {
  status: 'confirmed';
  evidence: ConfirmationEvidence;
};

const MAX_OBSERVATION = 2_000;

function validEvidence(
  evidence: ConfirmationEvidence | undefined
): asserts evidence is ConfirmationEvidence {
  const invalid = (reason: string): never => {
    throw new VisualAuditError(
      'INVALID_EVIDENCE',
      `INVALID_EVIDENCE: confirmation evidence is invalid: ${reason}`
    );
  };
  if (evidence === null || typeof evidence !== 'object') invalid('missing');
  if (evidence?.method !== 'independent-reproduction')
    invalid('method must be independent-reproduction (a scanner opinion is not evidence)');
  if (typeof evidence?.reproducedAt !== 'string' || Number.isNaN(Date.parse(evidence.reproducedAt)))
    invalid('reproducedAt must be an ISO-8601 time');
  if (
    typeof evidence?.observation !== 'string' ||
    evidence.observation.trim() === '' ||
    evidence.observation.length > MAX_OBSERVATION
  )
    invalid(`observation must be a non-empty description of at most ${MAX_OBSERVATION} characters`);
  const cleanup = evidence?.cleanup;
  if (
    cleanup === null ||
    typeof cleanup !== 'object' ||
    typeof cleanup.required !== 'boolean' ||
    typeof cleanup.performed !== 'boolean' ||
    typeof cleanup.note !== 'string'
  )
    invalid('cleanup must record required, performed and a note');
}

/** Promote a suspected finding to confirmed. The input is not mutated. */
export function confirmFinding<T extends { status: 'suspected' | 'confirmed' }>(
  finding: T,
  evidence: ConfirmationEvidence
): Confirmed<T> {
  if (finding.status !== 'suspected')
    throw new VisualAuditError(
      'INVALID_EVIDENCE',
      'INVALID_EVIDENCE: only a suspected finding can be confirmed'
    );
  validEvidence(evidence);
  if (evidence.cleanup.required && !evidence.cleanup.performed)
    throw new VisualAuditError(
      'CLEANUP_INCOMPLETE',
      'CLEANUP_INCOMPLETE: the reproduction created state that was not cleaned up; finish cleanup before confirming'
    );
  return { ...finding, status: 'confirmed', evidence: structuredClone(evidence) };
}
