import { legacyApprovalMode } from '@agentbrowser/core';
import { compilePrivateCIDRs } from '@agentbrowser/policy';
import type { PolicyDecision } from '@agentbrowser/protocol';
import type { AuthorizationRequest, Authorizer, EgressAuthorizationRequest } from './authorizer.js';

export interface LegacyAuthorizerOptions {
  /** `AGENTBROWSER_APPROVAL_POLICY.unknownRisk`; default `allow`. */
  unknownRisk?: 'allow' | 'required';
  /** `AGENTBROWSER_ALLOW_LOOPBACK`; default false. */
  allowLoopback?: boolean;
  /** `AGENTBROWSER_ALLOWED_CIDRS`; default none. Same strict syntax as NetworkPolicy. */
  allowedPrivateCIDRs?: string[];
}

/**
 * Today's operator decisions, unchanged, behind the Authorizer seam
 * (TD-BROWSER-15 phase 1). Rule ids use the `env.` prefix ADR-024 reserves for
 * decisions derived from environment configuration.
 */
export class LegacyAuthorizer implements Authorizer {
  readonly version = 'legacy';
  private readonly unknownRisk: 'allow' | 'required';
  private readonly allowLoopback: boolean;
  private readonly allowedPrivate: ReturnType<typeof compilePrivateCIDRs>['ranges'];

  constructor(options: LegacyAuthorizerOptions) {
    this.unknownRisk = options.unknownRisk ?? 'allow';
    this.allowLoopback = options.allowLoopback ?? false;
    this.allowedPrivate = compilePrivateCIDRs(options.allowedPrivateCIDRs ?? []).ranges;
  }

  decide(request: AuthorizationRequest): PolicyDecision {
    switch (request.action) {
      case 'act':
      case 'act.unattended':
        return this.decideAct(request);
      case 'request.loopback':
        return this.allowLoopback
          ? {
              allowed: true,
              reason: 'AGENTBROWSER_ALLOW_LOOPBACK is set',
              ruleMatched: 'env.allow-loopback',
            }
          : { allowed: false, reason: 'loopback is blocked', ruleMatched: 'env.block-loopback' };
      case 'request.private':
        return this.decidePrivate(request);
      case 'downloads':
      case 'serviceWorkers':
      case 'cookie.seed':
      case 'cookie.export':
      case 'session.headed':
        // Today a session gets every capability it requests.
        return {
          allowed: true,
          reason: 'granted on request; no policy file is loaded',
          ruleMatched: 'env.capability.default',
        };
    }
  }

  private decidePrivate(request: EgressAuthorizationRequest): PolicyDecision {
    // Every source of privateness must be inside an operator CIDR.
    const covered = request.context.privateSources.every((source) =>
      this.allowedPrivate.check(source.address, source.type)
    );
    return covered
      ? {
          allowed: true,
          reason: 'inside AGENTBROWSER_ALLOWED_CIDRS',
          ruleMatched: 'env.allowed-cidrs',
        }
      : {
          allowed: false,
          reason: 'private addresses are blocked',
          ruleMatched: 'env.block-private',
        };
  }

  private decideAct({
    action,
    context,
  }: Extract<AuthorizationRequest, { action: 'act' | 'act.unattended' }>): PolicyDecision {
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
