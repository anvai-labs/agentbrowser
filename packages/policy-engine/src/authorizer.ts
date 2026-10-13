import type { ActionRiskClassification, ApprovalMode } from '@agentbrowser/core';
import type { PolicyDecision } from '@agentbrowser/protocol';

/**
 * ADR-024 §5: whether a classified action may run at all (`act`), and whether
 * it may run without an approval token (`act.unattended`).
 */
export type ActAuthorizationRequest = {
  action: 'act' | 'act.unattended';
  context: ActionRiskClassification;
};

export type AuthorizationRequest = ActAuthorizationRequest;

/**
 * The one seam every operator-chosen decision goes through (TD-BROWSER-15).
 * Decisions are synchronous: implementations pre-parse whatever they need. A
 * thrown error is a bug; implementations deny rather than throw.
 */
export interface Authorizer {
  /** Identifies the policy that made a decision; stamped on sessions later. */
  readonly version: string;
  decide(request: AuthorizationRequest): PolicyDecision;
}

/** The three-valued approval outcome from the two `act` questions. */
export function approvalModeOf(
  authorizer: Authorizer,
  context: ActionRiskClassification
): ApprovalMode {
  if (!authorizer.decide({ action: 'act', context }).allowed) return 'deny';
  return authorizer.decide({ action: 'act.unattended', context }).allowed ? 'allow' : 'required';
}
