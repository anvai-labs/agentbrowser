import type { ActionRiskClassification, ActionRiskRule } from '@agentbrowser/core';
import type { EgressExceptionContext } from '@agentbrowser/policy';
import type { PolicyDecision } from '@agentbrowser/protocol';
import { CEDAR_SCHEMA } from '@agentbrowser/protocol';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import { describe, expect, it } from 'vitest';
import {
  type CedarGenerationConfig,
  cedarPolicySetFromLegacyConfig,
  normalizeSourceForCedar,
} from './cedar-generator.js';
import { LegacyAuthorizer } from './legacy-authorizer.js';

/**
 * The generated policy set against the real pinned wasm build: strict
 * validation must pass with zero errors, and a fixed decision matrix must
 * match `LegacyAuthorizer` exactly. The request-building here (one ask per
 * private source, reasons translated through `@rule`) is the same shape
 * `CedarAuthorizer` will own in phase 3b.
 */

const CONFIG: CedarGenerationConfig = {
  unknownRisk: 'required',
  allowLoopback: true,
  allowedPrivateCIDRs: ['10.0.0.0/8', '::ffff:192.168.1.0/120', 'fd12::/32'],
  rules: [
    { id: 'pay', effect: 'transaction', decision: 'deny' },
    { id: 'send-mail', effect: 'external-message', decision: 'allow' },
    { effect: 'read', decision: 'required' },
  ],
};

const set = cedarPolicySetFromLegacyConfig(CONFIG);
const staticPolicies = Object.fromEntries(set.map((p) => [p.key, p.cedar]));
const ruleIdOf = new Map(set.map((p) => [p.key, p.ruleId]));
const entities = [
  { uid: { type: 'AgentBrowser::Session', id: 's' }, attrs: {}, parents: [] },
  { uid: { type: 'AgentBrowser::Host', id: 'h' }, attrs: {}, parents: [] },
];

function ask(action: string, context: Record<string, unknown>) {
  const result = cedar.isAuthorized({
    principal: { type: 'AgentBrowser::Session', id: 's' },
    action: { type: 'AgentBrowser::Action', id: action },
    resource: { type: 'AgentBrowser::Host', id: 'h' },
    context,
    policies: { staticPolicies },
    schema: CEDAR_SCHEMA,
    entities,
  });
  if (result.type !== 'success') throw new Error(JSON.stringify(result.errors));
  const { decision, diagnostics } = result.response;
  const ids = diagnostics.reason.map((key) => ruleIdOf.get(key) ?? `<unknown:${key}>`).sort();
  return { allowed: decision === 'allow', ruleMatched: ids[0] ?? 'none', rulesMatched: ids };
}

/** The per-source ask and conjunction a CedarAuthorizer performs. */
function askPrivate(context: EgressExceptionContext): PolicyDecision {
  let ruleMatched = 'env.block-private';
  for (const source of context.privateSources) {
    const address = normalizeSourceForCedar(source.address, source.type);
    const answer = ask('request.private', {
      phase: context.phase,
      target: context.target,
      addressClasses: context.addressClasses,
      ip: { __extn: { fn: 'ip', arg: address } },
    });
    if (!answer.allowed)
      return { allowed: false, reason: 'private', ruleMatched: answer.ruleMatched };
    ruleMatched = answer.ruleMatched;
  }
  return {
    allowed: true,
    reason: '',
    ruleMatched: ruleMatched === 'none' ? 'env.allowed-cidrs' : ruleMatched,
  };
}

const privateSources = (address: string, type: 'ipv4' | 'ipv6') => [{ address, type }];
const egressContext = (
  sources: Array<{ address: string; type: 'ipv4' | 'ipv6' }>
): EgressExceptionContext => ({
  phase: 'resolved',
  target: sources[0]?.address ?? '',
  addressClasses: ['private'],
  privateSources: sources,
});

describe('generated policy set validates', () => {
  const configs: CedarGenerationConfig[] = [
    {},
    { allowLoopback: true },
    { allowedPrivateCIDRs: ['::/0'] },
    { allowedPrivateCIDRs: ['::ffff:0:0/96'] },
    { unknownRisk: 'required', rules: [{ effect: 'read' }] },
    CONFIG,
    { rules: [{ id: 'weird.id-1', effect: 'destructive', decision: 'required' }] },
  ];
  for (const [i, config] of configs.entries()) {
    it(`strict, zero validation errors (${JSON.stringify(config).slice(0, 60)}…)`, () => {
      const policies = Object.fromEntries(
        cedarPolicySetFromLegacyConfig(config).map((p) => [p.key, p.cedar])
      );
      const result = cedar.validate({
        schema: CEDAR_SCHEMA,
        policies: { staticPolicies: policies },
        validationSettings: { mode: 'strict' },
      });
      expect({ type: result.type, i }).toEqual({ type: 'success', i });
      if (result.type === 'success') expect(result.validationErrors).toEqual([]);
    });
  }
});

describe('generated policy set decides like LegacyAuthorizer', () => {
  const legacy = new LegacyAuthorizer(CONFIG);

  const privateCases: Array<[string, Array<{ address: string; type: 'ipv4' | 'ipv6' }>]> = [
    ['10.1.2.3 in 10/8', privateSources('10.1.2.3', 'ipv4')],
    ['192.168.1.5 via mapped-space rule', privateSources('192.168.1.5', 'ipv4')],
    ['192.168.2.5 outside', privateSources('192.168.2.5', 'ipv4')],
    ['mapped source, dotted', privateSources('::ffff:10.1.2.3', 'ipv6')],
    ['NAT64 wrapper not granted by 10/8', privateSources('64:ff9b::a01:203', 'ipv6')],
    ['fd12::1 in fd12::/32', privateSources('fd12::1', 'ipv6')],
    [
      'mixed covered sources',
      [privateSources('10.1.2.3', 'ipv4')[0], privateSources('fd12::1', 'ipv6')[0]],
    ],
    [
      'one uncovered source denies',
      [privateSources('10.1.2.3', 'ipv4')[0], privateSources('fd13::1', 'ipv6')[0]],
    ],
  ];
  for (const [name, sources] of privateCases) {
    it(`request.private: ${name}`, () => {
      const context = egressContext(sources);
      const want = legacy.decide({ action: 'request.private', context });
      expect({ ...askPrivate(context), reason: want.reason }).toEqual(want);
    });
  }

  it('request.loopback: allowed by the flag', () => {
    const context: EgressExceptionContext = {
      phase: 'hostname',
      target: 'localhost',
      addressClasses: ['loopback'],
      privateSources: [],
    };
    const answer = ask('request.loopback', {
      phase: context.phase,
      target: context.target,
      addressClasses: context.addressClasses,
    });
    const want = legacy.decide({ action: 'request.loopback', context });
    expect({ ...answer, reason: want.reason, rulesMatched: want.rulesMatched }).toEqual(want);
  });

  const actCases: Array<[ActionRiskClassification['effect'], string | undefined]> = [
    ['transaction', 'pay'],
    ['external-message', 'send-mail'],
    ['read', 'rule-2'],
    ['unknown', 'none'],
    ['transaction', 'none'],
    ['read', 'none'],
    ['destructive', 'none'],
    ['unknown', 'pay'],
  ];
  for (const [effect, matchedRule] of actCases) {
    const classification: ActionRiskClassification =
      matchedRule === 'none' || matchedRule === undefined
        ? { effect }
        : {
            effect,
            rule: {
              id: matchedRule,
              ...(decidedId(matchedRule)
                ? { decision: decidedId(matchedRule) as 'allow' | 'required' | 'deny' }
                : {}),
            },
          };
    for (const action of ['act', 'act.unattended'] as const) {
      it(`${action}: ${effect} with rule ${matchedRule ?? 'none'}`, () => {
        const answer = ask(action, { effect, matchedRule: matchedRule ?? 'none' });
        const want = legacy.decide({ action, context: classification });
        expect({ ...answer, reason: want.reason, rulesMatched: want.rulesMatched }).toEqual(want);
      });
    }
  }

  it('capability: downloads granted', () => {
    const answer = ask('downloads', {});
    const want = legacy.decide({ action: 'downloads', context: {} });
    expect({ ...answer, reason: want.reason, rulesMatched: want.rulesMatched }).toEqual(want);
  });
});

function decidedId(id: string): 'allow' | 'required' | 'deny' | undefined {
  const rules: ActionRiskRule[] = CONFIG.rules ?? [];
  const rule = rules.find((r, i) => (r.id ?? `rule-${i}`) === id);
  return rule?.decision;
}
