// TD-BROWSER-15 phase 2: 22 plausible-but-wrong Authorizers, written by the
// PR's adversarial review. Before the fixes, 14 of them passed the oracle. Each
// must now be caught on every seed, so a weakened oracle fails here first.

import { compilePrivateCIDRs } from '@agentbrowser/policy';
import type { PolicyDecision } from '@agentbrowser/protocol';
import { describe, expect, it } from 'vitest';
import type { AuthorizationRequest, Authorizer } from './authorizer.js';
import { assertEquivalentToLegacy, type LegacyConfig } from './differential.harness.js';
import { LegacyAuthorizer } from './legacy-authorizer.js';

const legacyOf = (c: LegacyConfig, cidrs = c.allowedPrivateCIDRs) =>
  new LegacyAuthorizer({
    allowLoopback: c.allowLoopback,
    allowedPrivateCIDRs: cidrs,
    unknownRisk: c.unknownRisk,
  });
type M = (c: LegacyConfig) => (r: AuthorizationRequest, l: LegacyAuthorizer) => PolicyDecision;
const ALLOW_P: PolicyDecision = { allowed: true, reason: 'x', ruleMatched: 'env.allowed-cidrs' };
const DENY_P: PolicyDecision = { allowed: false, reason: 'x', ruleMatched: 'env.block-private' };

const mutants: Record<string, M> = {
  'cidr /24 widened to /16': (c) => {
    const l2 = legacyOf(
      c,
      c.allowedPrivateCIDRs.map((x) => (x === '192.168.1.0/24' ? '192.168.0.0/16' : x))
    );
    return (r) => l2.decide(r);
  },
  'cidr /12 narrowed to /13': (c) => {
    const l2 = legacyOf(
      c,
      c.allowedPrivateCIDRs.map((x) => (x === '172.16.0.0/12' ? '172.16.0.0/13' : x))
    );
    return (r) => l2.decide(r);
  },
  'cidr 10/8 narrowed to /9': (c) => {
    const l2 = legacyOf(
      c,
      c.allowedPrivateCIDRs.map((x) => (x === '10.0.0.0/8' ? '10.0.0.0/9' : x))
    );
    return (r) => l2.decide(r);
  },
  'cidr 100.64/10 narrowed to /11': (c) => {
    const l2 = legacyOf(
      c,
      c.allowedPrivateCIDRs.map((x) => (x === '100.64.0.0/10' ? '100.64.0.0/11' : x))
    );
    return (r) => l2.decide(r);
  },
  'private: some() instead of every() over sources': (c) => {
    const { ranges } = compilePrivateCIDRs(c.allowedPrivateCIDRs);
    return (r, l) =>
      r.action === 'request.private'
        ? r.context.privateSources.some((s) => ranges.check(s.address, s.type))
          ? ALLOW_P
          : DENY_P
        : l.decide(r);
  },
  'private: only first source checked': (c) => {
    const { ranges } = compilePrivateCIDRs(c.allowedPrivateCIDRs);
    return (r, l) =>
      r.action === 'request.private'
        ? r.context.privateSources[0] &&
          ranges.check(r.context.privateSources[0].address, r.context.privateSources[0].type)
          ? ALLOW_P
          : DENY_P
        : l.decide(r);
  },
  'private: ipv6 sources ignored when an ipv4 source exists (wrapper granted by v4 CIDR)': (c) => {
    const { ranges } = compilePrivateCIDRs(c.allowedPrivateCIDRs);
    return (r, l) => {
      if (r.action !== 'request.private') return l.decide(r);
      const s = r.context.privateSources;
      const v4 = s.filter((x) => x.type === 'ipv4');
      const use = v4.length ? v4 : s;
      return use.every((x) => ranges.check(x.address, x.type)) ? ALLOW_P : DENY_P;
    };
  },
  'private: loopback-classed contexts allowed when allowLoopback': (c) => (r, l) =>
    r.action === 'request.private' &&
    c.allowLoopback &&
    r.context.addressClasses.includes('loopback')
      ? ALLOW_P
      : l.decide(r),
  'private: always denies loopback-classed (::1 under ::/0)': (c) => (r, l) =>
    r.action === 'request.private' && r.context.addressClasses.includes('loopback')
      ? DENY_P
      : l.decide(r),
  'private: decided on phase=hostname only, resolved always allowed if allowLoopback':
    (c) => (r, l) =>
      r.action === 'request.private' &&
      r.context.phase === 'resolved' &&
      r.context.privateSources.length > 1
        ? ALLOW_P
        : l.decide(r),

  'mapped ipv6 source not matched by ipv4 CIDR (Cedar cross-family isInRange)': (c) => {
    const { ranges } = compilePrivateCIDRs(c.allowedPrivateCIDRs);
    return (r, l) =>
      r.action === 'request.private'
        ? r.context.privateSources.every((s) =>
            s.type === 'ipv6' && s.address.startsWith('::ffff:') && s.address.includes('.')
              ? false
              : ranges.check(s.address, s.type)
          )
          ? ALLOW_P
          : DENY_P
        : l.decide(r);
  },
  'ipv6 CIDR covering target grants embedded ipv4': (c) => {
    const { ranges } = compilePrivateCIDRs(c.allowedPrivateCIDRs);
    return (r, l) =>
      r.action === 'request.private' &&
      r.context.target.includes(':') &&
      ranges.check(r.context.target.replace(/^\[|\]$/g, ''), 'ipv6')
        ? ALLOW_P
        : l.decide(r);
  },
  'capability depends on tenantId': () => (r, l) =>
    r.action === 'downloads' && (r.context as { tenantId?: string }).tenantId === undefined
      ? { allowed: false, reason: 'x', ruleMatched: 'env.capability.default' }
      : l.decide(r),
  'capability denied for other tenants': () => (r, l) =>
    r.action === 'cdp.attach' && (r.context as { tenantId?: string }).tenantId !== 't1'
      ? { allowed: false, reason: 'x', ruleMatched: 'env.capability.default' }
      : l.decide(r),
  'ruleMatched uses rule-<index> even for explicit ids': (c) => (r, l) => {
    const d = l.decide(r);
    if (
      (r.action === 'act' || r.action === 'act.unattended') &&
      r.context.rule?.decision !== undefined
    ) {
      const i = c.rules.findIndex((x, k) => (x.id ?? `rule-${k}`) === r.context.rule?.id);
      return { ...d, ruleMatched: `env.approval.rule-${i}` };
    }
    return d;
  },
  'rule decision looked up by index parsed from rule-<n>': (c) => (r, l) => {
    if ((r.action === 'act' || r.action === 'act.unattended') && r.context.rule) {
      const n = Number(r.context.rule.id.replace('rule-', ''));
      const dec = c.rules[n]?.decision;
      if (Number.isNaN(n)) return { allowed: false, reason: 'x', ruleMatched: 'engine.error' };
      return l.decide({
        ...r,
        context: {
          ...r.context,
          rule: { id: r.context.rule.id, ...(dec ? { decision: dec } : {}) },
        },
      });
    }
    return l.decide(r);
  },
  'unknownRisk applied to write-local': (c) => (r, l) =>
    (r.action === 'act' || r.action === 'act.unattended') &&
    r.context.effect === 'write-local' &&
    !r.context.rule?.decision
      ? l.decide({ ...r, context: { ...r.context, effect: 'unknown' } })
      : l.decide(r),
  'unknownRisk inverted only for destructive without rule': (c) => (r, l) =>
    r.action === 'act.unattended' &&
    r.context.effect === 'destructive' &&
    !r.context.rule?.decision &&
    c.unknownRisk === 'allow'
      ? { allowed: true, reason: 'x', ruleMatched: 'env.approval.high-risk' }
      : l.decide(r),
  'rule with no decision treated as allow': () => (r, l) =>
    (r.action === 'act' || r.action === 'act.unattended') &&
    r.context.rule &&
    r.context.rule.decision === undefined
      ? { allowed: true, reason: 'x', ruleMatched: `env.approval.${r.context.rule.id}` }
      : l.decide(r),
  'rule required treated as allow only for transaction': () => (r, l) =>
    r.action === 'act.unattended' &&
    r.context.rule?.decision === 'required' &&
    r.context.effect === 'transaction'
      ? { allowed: true, reason: 'x', ruleMatched: `env.approval.${r.context.rule.id}` }
      : l.decide(r),
  'throws on request.private': () => (r, l) => {
    if (r.action === 'request.private') throw new Error('boom');
    return l.decide(r);
  },
  'loopback allow ruleMatched wrong only on resolved phase': () => (r, l) => {
    const d = l.decide(r);
    return r.action === 'request.loopback' && r.context.phase === 'resolved' && d.allowed
      ? { ...d, ruleMatched: 'env.x' }
      : d;
  },
};

describe('differential oracle catches every mutant', () => {
  const seeds = [1, 42];
  for (const [name, mutant] of Object.entries(mutants)) {
    it(name, async () => {
      for (const seed of seeds) {
        await expect(
          assertEquivalentToLegacy(
            (c) => {
              const legacy = legacyOf(c);
              const decide = mutant(c);
              return { version: 'mutant', decide: (r) => decide(r, legacy) } satisfies Authorizer;
            },
            { numRuns: 300, seed }
          )
        ).rejects.toThrow(/Divergence/);
      }
    }, 120_000);
  }
});
