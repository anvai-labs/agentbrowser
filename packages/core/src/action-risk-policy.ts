import type { ActionEffectType, ApprovalPolicy, PageElement } from '@agentbrowser/protocol';

export type ApprovalMode = 'allow' | 'required' | 'deny';
export interface ActionRiskRule {
  hostname?: string;
  action?: string;
  role?: string;
  name?: string;
  effect: ActionEffectType;
  decision?: ApprovalMode;
}
export interface ActionRiskPolicyOptions {
  /** Exact, operator-owned matches; first matching rule wins. No page-provided rules. */
  rules?: readonly ActionRiskRule[];
  unknownRisk?: 'allow' | 'required';
}
const HIGH_RISK = new Set(['transaction', 'account-security', 'external-message', 'destructive']);
const READ_ACTIONS = new Set(['hover', 'scroll', 'wait']);
const rank = { allow: 0, required: 1, deny: 2 };

/** Classification is deployment policy, never guessed from arbitrary page prose. */
export class ActionRiskPolicy {
  private readonly rules: readonly Readonly<ActionRiskRule>[];
  private readonly unknownRisk: 'allow' | 'required';
  constructor(options: ActionRiskPolicyOptions = {}) {
    if (
      options === null ||
      typeof options !== 'object' ||
      (options.rules !== undefined && !Array.isArray(options.rules)) ||
      (options.unknownRisk !== undefined && !['allow', 'required'].includes(options.unknownRisk))
    ) {
      throw new Error('Invalid operator approval policy');
    }
    for (const rule of options.rules ?? []) {
      if (
        rule === null ||
        typeof rule !== 'object' ||
        !['read', 'write-local', ...HIGH_RISK].includes(rule.effect) ||
        (rule.decision !== undefined && !['allow', 'required', 'deny'].includes(rule.decision)) ||
        [rule.hostname, rule.action, rule.role, rule.name].some(
          (value) => value !== undefined && (typeof value !== 'string' || value.length > 200)
        )
      ) {
        throw new Error('Invalid operator approval rule');
      }
    }
    if ((options.rules?.length ?? 0) > 1000)
      throw new Error('At most 1000 approval rules are supported');
    this.rules = (options.rules ?? []).map((rule) => Object.freeze({ ...rule }));
    this.unknownRisk = options.unknownRisk ?? 'allow';
  }

  evaluate(
    input: { action: string; url: string; element?: PageElement },
    session: ApprovalPolicy = {}
  ): { effect: ActionEffectType | 'unknown'; decision: ApprovalMode } {
    let hostname = '';
    try {
      hostname = new URL(input.url).hostname;
    } catch {
      /* Blank pages have no host. */
    }
    const rule = this.rules.find(
      (candidate) =>
        (candidate.hostname === undefined || candidate.hostname.toLowerCase() === hostname) &&
        (candidate.action === undefined || candidate.action === input.action) &&
        (candidate.role === undefined || candidate.role === input.element?.role) &&
        (candidate.name === undefined || candidate.name === input.element?.name)
    );
    const effect =
      rule?.effect ??
      (READ_ACTIONS.has(input.action) ? 'read' : (input.element?.risk ?? 'unknown'));
    let decision: ApprovalMode =
      rule?.decision ??
      (effect === 'unknown' ? this.unknownRisk : HIGH_RISK.has(effect) ? 'required' : 'allow');
    const restriction =
      effect === 'transaction'
        ? session.transactions
        : effect === 'external-message'
          ? session.externalMessages
          : undefined;
    if (restriction !== undefined && rank[restriction] > rank[decision]) decision = restriction;
    return { effect, decision };
  }
}
