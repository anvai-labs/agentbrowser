import type { ActionEffectType, PageElement } from '@agentbrowser/protocol';
import { describe, expect, it } from 'vitest';
import {
  ActionRiskPolicy,
  type ActionRiskRule,
  legacyApprovalMode,
  tightenApprovalMode,
} from './action-risk-policy.js';

// TD-BROWSER-15 phase 1: classification (first-match rule -> effect) is split
// from the outcome so an Authorizer can decide. Recomposed, it must equal
// evaluate() exactly.

const EFFECTS: ActionEffectType[] = [
  'read',
  'write-local',
  'transaction',
  'account-security',
  'external-message',
  'destructive',
];
const ACTIONS = ['click', 'fill', 'hover', 'scroll', 'wait', 'press', 'select'];
const HOSTS = ['shop.example', 'mail.example', 'other.example'];
const ROLES = ['button', 'link', 'textbox'];
const NAMES = ['Pay', 'Send', 'Search'];
const MODES = ['allow', 'required', 'deny'] as const;

/** Small deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const maybe = <T>(r: () => number, x: T): T | undefined => (r() < 0.5 ? x : undefined);

function randomRule(r: () => number): ActionRiskRule {
  const rule: ActionRiskRule = { effect: pick(r, EFFECTS) };
  const hostname = maybe(r, pick(r, HOSTS));
  const action = maybe(r, pick(r, ACTIONS));
  const role = maybe(r, pick(r, ROLES));
  const name = maybe(r, pick(r, NAMES));
  const decision = maybe(r, pick(r, MODES));
  if (hostname !== undefined) rule.hostname = r() < 0.2 ? hostname.toUpperCase() : hostname;
  if (action !== undefined) rule.action = action;
  if (role !== undefined) rule.role = role;
  if (name !== undefined) rule.name = name;
  if (decision !== undefined) rule.decision = decision;
  return rule;
}

describe('ActionRiskPolicy.classify', () => {
  it('reports the first matching rule by index and its own id', () => {
    const policy = new ActionRiskPolicy({
      rules: [
        { hostname: 'shop.example', action: 'click', effect: 'transaction' },
        { id: 'pay-button', name: 'Pay', effect: 'transaction', decision: 'deny' },
      ],
    });
    expect(
      policy.classify({ action: 'fill', url: 'https://x.example/', element: el('Pay') })
    ).toEqual({ effect: 'transaction', rule: { id: 'pay-button', decision: 'deny' } });
    expect(policy.classify({ action: 'click', url: 'https://shop.example/' })).toEqual({
      effect: 'transaction',
      rule: { id: 'rule-0' },
    });
    expect(policy.classify({ action: 'hover', url: 'about:blank' })).toEqual({ effect: 'read' });
  });

  it.each([
    [[{ id: 'a' }, { id: 'a' }], 'rule 1: id "a" duplicates an earlier rule id'],
    [[{ id: '' }], 'rule 0: id "" must be'],
    [[{ id: 'Pay Button' }], 'rule 0: id "Pay Button" must be'],
    [[{ id: 7 }], 'rule 0: id 7 must be'],
    [[{ id: 'x'.repeat(65) }], `rule 0: id "${'x'.repeat(65)}" must be 1-64`],
    [[{ id: 'rule-3' }], 'rule 0: id "rule-3" is reserved'],
    [[{ id: 'none' }], 'rule 0: id "none" is reserved'],
  ])('refuses rule ids %j, naming the rule and the reason', (ids, message) => {
    const rules = (ids as Array<{ id: unknown }>).map(
      (x) => ({ ...x, effect: 'read' }) as unknown as ActionRiskRule
    );
    expect(() => new ActionRiskPolicy({ rules })).toThrow(`Invalid operator approval ${message}`);
  });

  it('still loads every rule without an id, as before', () => {
    expect(
      () => new ActionRiskPolicy({ rules: [{ effect: 'read' }, { effect: 'transaction' }] })
    ).not.toThrow();
  });

  it('recomposes to evaluate() exactly over generated policies and inputs', () => {
    const r = rng(0x5eed);
    for (let p = 0; p < 300; p++) {
      const rules = Array.from({ length: Math.floor(r() * 6) }, () => randomRule(r));
      const unknownRisk = pick(r, ['allow', 'required'] as const);
      const policy = new ActionRiskPolicy({ rules, unknownRisk });
      for (let i = 0; i < 40; i++) {
        const input = {
          action: pick(r, ACTIONS),
          url: r() < 0.1 ? 'about:blank' : `https://${pick(r, HOSTS)}/`,
          ...(r() < 0.8
            ? { element: el(pick(r, NAMES), pick(r, ROLES), maybe(r, pick(r, EFFECTS))) }
            : {}),
        };
        const session = {
          ...(r() < 0.3 ? { transactions: pick(r, MODES) } : {}),
          ...(r() < 0.3 ? { externalMessages: pick(r, MODES) } : {}),
        };
        const c = policy.classify(input);
        const mode = tightenApprovalMode(
          c.effect,
          legacyApprovalMode(c.effect, c.rule?.decision, unknownRisk),
          session
        );
        expect({ effect: c.effect, decision: mode }).toEqual(policy.evaluate(input, session));
      }
    }
  });
});

function el(name: string, role = 'button', risk?: ActionEffectType): PageElement {
  return { ref: 'e1_1', role, name, ...(risk !== undefined ? { risk } : {}) } as PageElement;
}
