import type { ActionEffectType, ApprovalPolicy, PageElement } from '@agentbrowser/protocol';

export type ApprovalMode = 'allow' | 'required' | 'deny';
export interface ActionRiskRule {
  /** Optional stable id, reported as the deciding rule; defaults to `rule-<index>`. */
  id?: string;
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
const RULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** First-match classification of one action (TD-BROWSER-15 phase 1). */
export interface ActionRiskClassification {
  effect: ActionEffectType | 'unknown';
  /** The first matching operator rule, if any: its id and its own decision. */
  rule?: { id: string; decision?: ApprovalMode };
}

/**
 * Today's operator outcome for a classified action: a matching rule's own
 * decision wins; otherwise unknown effects follow `unknownRisk`, high-risk
 * effects require approval, and everything else is allowed.
 */
export function legacyApprovalMode(
  effect: ActionEffectType | 'unknown',
  ruleDecision: ApprovalMode | undefined,
  unknownRisk: 'allow' | 'required'
): ApprovalMode {
  return (
    ruleDecision ??
    (effect === 'unknown' ? unknownRisk : HIGH_RISK.has(effect) ? 'required' : 'allow')
  );
}

/** Session approval policy can only tighten an outcome, never relax it. */
export function tightenApprovalMode(
  effect: ActionEffectType | 'unknown',
  mode: ApprovalMode,
  session: ApprovalPolicy = {}
): ApprovalMode {
  const restriction =
    effect === 'transaction'
      ? session.transactions
      : effect === 'external-message'
        ? session.externalMessages
        : undefined;
  return restriction !== undefined && rank[restriction] > rank[mode] ? restriction : mode;
}

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
        (rule.id !== undefined && (typeof rule.id !== 'string' || !RULE_ID.test(rule.id))) ||
        [rule.hostname, rule.action, rule.role, rule.name].some(
          (value) => value !== undefined && (typeof value !== 'string' || value.length > 200)
        )
      ) {
        throw new Error('Invalid operator approval rule');
      }
    }
    if ((options.rules?.length ?? 0) > 1000)
      throw new Error('At most 1000 approval rules are supported');
    const ids = (options.rules ?? []).map((rule) => rule.id).filter((id) => id !== undefined);
    if (new Set(ids).size !== ids.length) throw new Error('Invalid operator approval rule');
    this.rules = (options.rules ?? []).map((rule) => Object.freeze({ ...rule }));
    this.unknownRisk = options.unknownRisk ?? 'allow';
  }

  /** The policy-wide outcome for actions no rule classifies. */
  get unknownRiskMode(): 'allow' | 'required' {
    return this.unknownRisk;
  }

  /** First-match classification: the effect and the matching rule, without an outcome. */
  classify(input: {
    action: string;
    url: string;
    element?: PageElement;
  }): ActionRiskClassification {
    let hostname = '';
    try {
      hostname = new URL(input.url).hostname;
    } catch {
      /* Blank pages have no host. */
    }
    const index = this.rules.findIndex(
      (candidate) =>
        (candidate.hostname === undefined || candidate.hostname.toLowerCase() === hostname) &&
        (candidate.action === undefined || candidate.action === input.action) &&
        (candidate.role === undefined || candidate.role === input.element?.role) &&
        (candidate.name === undefined || candidate.name === input.element?.name)
    );
    const rule = index >= 0 ? this.rules[index] : undefined;
    const effect =
      rule?.effect ??
      (READ_ACTIONS.has(input.action) ? 'read' : (input.element?.risk ?? 'unknown'));
    if (!rule) return { effect };
    return {
      effect,
      rule: {
        id: rule.id ?? `rule-${index}`,
        ...(rule.decision !== undefined ? { decision: rule.decision } : {}),
      },
    };
  }

  evaluate(
    input: { action: string; url: string; element?: PageElement },
    session: ApprovalPolicy = {}
  ): { effect: ActionEffectType | 'unknown'; decision: ApprovalMode } {
    const { effect, rule } = this.classify(input);
    const decision = tightenApprovalMode(
      effect,
      legacyApprovalMode(effect, rule?.decision, this.unknownRisk),
      session
    );
    return { effect, decision };
  }
}
