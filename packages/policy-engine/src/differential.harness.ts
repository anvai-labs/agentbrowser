/**
 * TD-BROWSER-15 phase 2: the differential oracle. Any Authorizer built from a
 * legacy configuration must decide exactly as LegacyAuthorizer does, for
 * generated configurations and inputs. Phase 3 plugs CedarAuthorizer (loaded
 * with the generated policy document) in as the subject.
 *
 * Contexts come from the real code paths (NetworkPolicy's classification,
 * ActionRiskPolicy.classify), never re-derived here, so the oracle cannot
 * drift from what enforcement actually asks.
 *
 * Test-only: excluded from the build (tsconfig `**\/*.harness.ts`).
 */
import { ActionRiskPolicy, type ActionRiskRule } from '@agentbrowser/core';
import { type EgressExceptionContext, NetworkPolicy } from '@agentbrowser/policy';
import type { PolicyDecision } from '@agentbrowser/protocol';
import fc from 'fast-check';
import type { AuthorizationRequest, Authorizer, CapabilityAction } from './authorizer.js';
import { LegacyAuthorizer } from './legacy-authorizer.js';

/** The environment-derived configuration LegacyAuthorizer models. */
export interface LegacyConfig {
  allowLoopback: boolean;
  allowedPrivateCIDRs: string[];
  unknownRisk: 'allow' | 'required';
  rules: ActionRiskRule[];
}

const CIDRS = [
  '10.0.0.0/8',
  '192.168.1.0/24',
  '172.16.0.0/12',
  '100.64.0.0/10',
  'fd12::/32',
  '0.0.0.0/0',
  '::/0',
  '64:ff9b::/96',
  '127.0.0.0/8',
  '::1/128',
  'fe80::/10',
];
const HOSTS = ['shop.example', 'mail.example', 'bank.example'];
const ACTIONS = ['click', 'fill', 'hover', 'scroll', 'wait', 'press', 'select', 'typeText'];
const ROLES = ['button', 'link', 'textbox', 'checkbox'];
const NAMES = ['Pay', 'Send', 'Search', 'Delete'];
const EFFECTS = [
  'read',
  'write-local',
  'transaction',
  'account-security',
  'external-message',
  'destructive',
] as const;
const MODES = ['allow', 'required', 'deny'] as const;
const CAPABILITIES: CapabilityAction[] = [
  'cdp.attach',
  'downloads',
  'serviceWorkers',
  'cookie.seed',
  'cookie.export',
  'session.headed',
];

const optional = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });

export const ruleArb: fc.Arbitrary<ActionRiskRule> = fc
  .record({
    hostname: optional(fc.constantFrom(...HOSTS)),
    action: optional(fc.constantFrom(...ACTIONS)),
    role: optional(fc.constantFrom(...ROLES)),
    name: optional(fc.constantFrom(...NAMES)),
    effect: fc.constantFrom(...EFFECTS),
    decision: optional(fc.constantFrom(...MODES)),
  })
  .map((r) => {
    // Optional fields are omitted, never `undefined` (exactOptionalPropertyTypes).
    const rule: ActionRiskRule = { effect: r.effect };
    if (r.hostname !== undefined) rule.hostname = r.hostname;
    if (r.action !== undefined) rule.action = r.action;
    if (r.role !== undefined) rule.role = r.role;
    if (r.name !== undefined) rule.name = r.name;
    if (r.decision !== undefined) rule.decision = r.decision;
    return rule;
  });

export const configArb: fc.Arbitrary<LegacyConfig> = fc.record({
  allowLoopback: fc.boolean(),
  allowedPrivateCIDRs: fc.uniqueArray(fc.constantFrom(...CIDRS), { maxLength: 3 }),
  unknownRisk: fc.constantFrom('allow' as const, 'required' as const),
  rules: fc.array(ruleArb, { maxLength: 6 }),
});

const v4 = fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255), fc.nat(255)).map((o) => o.join('.'));
const special4 = fc.constantFrom(
  '127.0.0.1',
  '10.1.2.3',
  '192.168.1.5',
  '172.16.9.9',
  '100.64.1.1',
  '169.254.169.254',
  '198.18.0.1',
  '0.0.0.0'
);
const hex = (n: number) => n.toString(16);
const asV6 = (a: string) => {
  const [p, q, r, s] = a.split('.').map(Number) as [number, number, number, number];
  return `${hex((p << 8) | q)}:${hex((r << 8) | s)}`;
};
/** IPv4, IPv6 and the embedded forms #444 decodes. */
export const addressArb: fc.Arbitrary<string> = fc.oneof(
  v4,
  special4,
  special4.map((a) => `::ffff:${a}`),
  special4.map((a) => `64:ff9b::${asV6(a)}`),
  special4.map((a) => `2002:${asV6(a)}::1`),
  special4.map((a) => `::${asV6(a)}`),
  special4.map((a) => `::ffff:0:${asV6(a)}`),
  fc.constantFrom(
    '::1',
    '::',
    'fd12::1',
    'fd12:1::1',
    'fe80::1',
    '2001:4860:4860::8888',
    'fd00:ec2::254'
  )
);
export const hostnameArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('localhost', 'localhost.localdomain', 'example.com'),
  addressArb.map((a) => (a.includes(':') ? `[${a}]` : a))
);

export const actInputArb = fc.record({
  action: fc.constantFrom(...ACTIONS),
  url: fc.constantFrom('about:blank', ...HOSTS.map((h) => `https://${h}/`)),
  element: optional(
    fc.record({
      ref: fc.constant('e1_1'),
      role: fc.constantFrom(...ROLES),
      name: fc.constantFrom(...NAMES),
      risk: optional(fc.constantFrom(...EFFECTS)),
    })
  ),
});

/** Every egress question enforcement asks for these targets, from the real path. */
export async function egressRequests(
  hosts: string[],
  addresses: string[]
): Promise<AuthorizationRequest[]> {
  const asked: AuthorizationRequest[] = [];
  const capture =
    (action: 'request.loopback' | 'request.private') => (context: EgressExceptionContext) => {
      asked.push({ action, context });
      return false; // keep asking: deny so every decision point runs
    };
  const policy = new NetworkPolicy({
    blockLoopback: true,
    blockPrivateIPs: true,
    exceptions: {
      allowLoopback: capture('request.loopback'),
      allowPrivate: capture('request.private'),
    },
  });
  for (const hostname of hosts) await policy.checkRequest({ hostname }).catch(() => {});
  for (const address of addresses) await policy.checkResolvedAddresses([address]).catch(() => {});
  return asked;
}

function same(a: PolicyDecision, b: PolicyDecision): boolean {
  return a.allowed === b.allowed && a.ruleMatched === b.ruleMatched;
}

/**
 * Assert `subjectFor(config)` decides exactly like LegacyAuthorizer(config).
 * Throws (fast-check counterexample) on the first difference.
 */
export async function assertEquivalentToLegacy(
  subjectFor: (config: LegacyConfig) => Authorizer,
  options: { numRuns?: number; seed?: number } = {}
): Promise<void> {
  try {
    await runProperty(subjectFor, options);
  } catch (error) {
    // fast-check 4 keeps the failing check's error in `cause`; surface it, so a
    // divergence names the request, both decisions and the context.
    const cause = (error as Error).cause;
    throw new Error(`${(error as Error).message}\n${cause instanceof Error ? cause.message : ''}`, {
      cause: error,
    });
  }
}

async function runProperty(
  subjectFor: (config: LegacyConfig) => Authorizer,
  options: { numRuns?: number; seed?: number }
): Promise<void> {
  await fc.assert(
    fc.asyncProperty(
      configArb,
      fc.array(hostnameArb, { maxLength: 6 }),
      fc.array(addressArb, { maxLength: 6 }),
      fc.array(actInputArb, { maxLength: 6 }),
      async (config, hosts, addresses, inputs) => {
        const oracle = new LegacyAuthorizer({
          allowLoopback: config.allowLoopback,
          allowedPrivateCIDRs: config.allowedPrivateCIDRs,
          unknownRisk: config.unknownRisk,
        });
        const subject = subjectFor(config);
        const classify = new ActionRiskPolicy({
          rules: config.rules,
          unknownRisk: config.unknownRisk,
        });
        const requests: AuthorizationRequest[] = [
          ...(await egressRequests(hosts, addresses)),
          ...inputs.flatMap((input) => {
            const context = classify.classify(input as Parameters<ActionRiskPolicy['classify']>[0]);
            return [
              { action: 'act', context } as const,
              { action: 'act.unattended', context } as const,
            ];
          }),
          ...CAPABILITIES.map((action) => ({ action, context: { tenantId: 't1' } })),
        ];
        for (const request of requests) {
          const expected = oracle.decide(request);
          const actual = subject.decide(request);
          if (!same(expected, actual)) {
            throw new Error(
              `Divergence on ${request.action}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}; context ${JSON.stringify(request.context)}`
            );
          }
        }
      }
    ),
    {
      numRuns: options.numRuns ?? 300,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    }
  );
}
