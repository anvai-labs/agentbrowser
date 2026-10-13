import { legacyApprovalMode } from '@agentbrowser/core';
import type { PolicyDecision } from '@agentbrowser/protocol';
import type { AuthorizationRequest, Authorizer } from './authorizer.js';

export interface LegacyAuthorizerOptions {
  /** `AGENTBROWSER_APPROVAL_POLICY.unknownRisk`; default `allow`. */
  unknownRisk?: 'allow' | 'required';
}

/**
 * Today's operator decisions, unchanged, behind the Authorizer seam
 * (TD-BROWSER-15 phase 1). Rule ids use the `env.` prefix ADR-024 reserves for
 * decisions derived from environment configuration.
 */
export class LegacyAuthorizer implements Authorizer {
  readonly version = 'legacy';
  private readonly unknownRisk: 'allow' | 'required';

  constructor(options: LegacyAuthorizerOptions) {
    this.unknownRisk = options.unknownRisk ?? 'allow';
  }

  decide({ action, context }: AuthorizationRequest): PolicyDecision {
    const mode = legacyApprovalMode(context.effect, context.rule?.decision, this.unknownRisk);
    const allowed = action === 'act' ? mode !== 'deny' : mode === 'allow';
    if (context.rule?.decision !== undefined) {
      return {
        allowed,
        reason: `operator rule ${context.rule.id}: ${context.rule.decision}`,
        ruleMatched: `env.approval.${context.rule.id}`,
      };
    }
    if (context.effect === 'unknown') {
      return {
        allowed,
        reason: `unknown risk: ${this.unknownRisk}`,
        ruleMatched: 'env.approval.unknown-risk',
      };
    }
    if (mode === 'required') {
      return {
        allowed,
        reason: `high-risk effect: ${context.effect}`,
        ruleMatched: 'env.approval.high-risk',
      };
    }
    return {
      allowed,
      reason: `effect ${context.effect} is allowed`,
      ruleMatched: 'env.approval.default',
    };
  }
}
