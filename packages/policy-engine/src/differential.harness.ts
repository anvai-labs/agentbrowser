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
 * Test-only: excluded from the build by tsconfig.build.json.
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
  '10.10.10.0/24',
  '192.168.1.0/24',
  '192.168.0.0/16',
  '172.16.0.0/12',
  '100.64.0.0/10',
  'fd12::/32',
  '0.0.0.0/0',
  '::/0',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '127.0.0.0/8',
  '::1/128',
  'fe80::/10',
];
const HOSTS = ['shop.example', 'mail.example', 'bank.example'];
const ACTIONS = ['click', 'fill', 'hover', 'scroll', 'wait', 'press', 'select', 'typeText'];
const ROLES = ['button', 'link', 'textbox', 'checkbox'];
const NAMES = ['Pay', 'Send', 'Search', 'Delete'];
export const EFFECTS = [
  'read',
  'write-local',
  'transaction',
  'account-security',
  'external-message',
  'destructive',
] as const;
export const MODES = ['allow', 'required', 'deny'] as const;
export const CAPABILITIES: CapabilityAction[] = [
  'cdp.attach',
  'downloads',
  'serviceWorkers',
  'cookie.seed',
  'cookie.export',
  'session.headed',
];
/** Absent tenant (keyless), and several tenants. */
const TENANTS = [undefined, 't1', 't2', 'tenant-with-a-longer-name'];

const optional = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });

const ruleArb: fc.Arbitrary<ActionRiskRule> = fc
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

/** Rules, some carrying a unique explicit id (else they are `rule-<index>`). */
const rulesArb: fc.Arbitrary<ActionRiskRule[]> = fc
  .array(fc.tuple(ruleArb, fc.boolean()), { maxLength: 6 })
  .map((pairs) => pairs.map(([rule, named], i) => (named ? { ...rule, id: `op-${i}.x` } : rule)));

export const configArb: fc.Arbitrary<LegacyConfig> = fc.record({
  allowLoopback: fc.boolean(),
  allowedPrivateCIDRs: fc.uniqueArray(fc.constantFrom(...CIDRS), { maxLength: 3 }),
  unknownRisk: fc.constantFrom('allow' as const, 'required' as const),
  rules: rulesArb,
});

// --- addresses -------------------------------------------------------------

const octet = fc.nat(255);
const v4 = fc.tuple(octet, octet, octet, octet).map((o) => o.join('.'));
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
const hex16 = (a: number, b: number) => ((a << 8) | b).toString(16);
const asV6 = (a: string) => {
  const [p, q, r, s] = a.split('.').map(Number) as [number, number, number, number];
  return `${hex16(p, q)}:${hex16(r, s)}`;
};
const privateOrSpecial4 = fc.oneof(special4, v4);

/**
 * RFC 8215 local-use NAT64 carrying two IPv4s in different RFC 6052 layouts
 * (A in the /48 slot, B in the /96 slot). The wrapper and both IPv4s can be
 * private, so the context has several private sources: the case where every
 * source must be covered, not one.
 */
const localUseNat64 = fc.tuple(privateOrSpecial4, privateOrSpecial4).map(([a, b]) => {
  const [a0, a1, a2, a3] = a.split('.').map(Number) as [number, number, number, number];
  return `64:ff9b:1:${hex16(a0, a1)}:${hex16(0, a2)}:${hex16(a3, 0)}:${asV6(b)}`;
});

/** IPv4, IPv6 and the embedded forms #444 decodes. */
export const addressArb: fc.Arbitrary<string> = fc.oneof(
  v4,
  special4,
  special4.map((a) => `::ffff:${a}`),
  special4.map((a) => `64:ff9b::${asV6(a)}`),
  special4.map((a) => `2002:${asV6(a)}::1`),
  special4.map((a) => `::${asV6(a)}`),
  special4.map((a) => `::ffff:0:${asV6(a)}`),
  localUseNat64,
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

/** First, last and one-past-either-end of a CIDR, so prefix off-by-ones are hit. */
export function cidrBoundaries(cidr: string): string[] {
  const [base = '', bits = '0'] = cidr.split('/');
  const prefix = Number(bits);
  if (base.includes(':')) {
    const words = expandV6(base);
    const value = words.reduce((acc, w) => (acc << 16n) | BigInt(w), 0n);
    const host = 128n - BigInt(prefix);
    const first = (value >> host) << host;
    const last = first | ((1n << host) - 1n);
    const max = (1n << 128n) - 1n;
    return [first, last, first - 1n, last + 1n].filter((x) => x >= 0n && x <= max).map(fromV6);
  }
  const value = base.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
  const size = 2 ** (32 - prefix);
  const first = Math.floor(value / size) * size;
  const last = first + size - 1;
  return [first, last, first - 1, last + 1]
    .filter((x) => x >= 0 && x <= 0xffffffff)
    .map((x) => [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join('.'));
}
function expandV6(address: string): number[] {
  const [head = '', tail] = address.split('::') as [string, string | undefined];
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((w) => Number.parseInt(w, 16));
}
function fromV6(value: bigint): string {
  const words: string[] = [];
  for (let i = 7; i >= 0; i--) words.push(((value >> BigInt(i * 16)) & 0xffffn).toString(16));
  return words.join(':');
}

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

/**
 * Every egress question enforcement asks for these targets, from the real path.
 * The capture ALLOWS, so each check continues past it: an address that is both
 * loopback and private (`::1`) is asked both questions, as production asks
 * `request.private` after a loopback exception.
 */
export async function egressRequests(
  hosts: string[],
  addresses: string[]
): Promise<AuthorizationRequest[]> {
  const asked: AuthorizationRequest[] = [];
  const capture =
    (action: 'request.loopback' | 'request.private') => (context: EgressExceptionContext) => {
      asked.push({ action, context });
      return true;
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

function compare(oracle: Authorizer, subject: Authorizer, requests: AuthorizationRequest[]): void {
  for (const request of requests) {
    const expected = oracle.decide(request);
    let actual: PolicyDecision;
    try {
      actual = subject.decide(request);
    } catch (error) {
      throw new Error(
        `Divergence on ${request.action}: the subject threw (${(error as Error).message}); expected ${JSON.stringify(expected)}; context ${JSON.stringify(request.context)}`
      );
    }
    if (!same(expected, actual)) {
      throw new Error(
        `Divergence on ${request.action}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}; context ${JSON.stringify(request.context)}`
      );
    }
  }
}

const legacyFor = (config: LegacyConfig) =>
  new LegacyAuthorizer({
    allowLoopback: config.allowLoopback,
    allowedPrivateCIDRs: config.allowedPrivateCIDRs,
    unknownRisk: config.unknownRisk,
  });

/**
 * Assert `subjectFor(config)` decides exactly like LegacyAuthorizer(config):
 * a deterministic table of every approval combination, then generated runs.
 */
export async function assertEquivalentToLegacy(
  subjectFor: (config: LegacyConfig) => Authorizer,
  options: { numRuns?: number; seed?: number } = {}
): Promise<void> {
  assertApprovalTable(subjectFor);
  try {
    await runProperty(subjectFor, options);
  } catch (error) {
    // fast-check 4 keeps the failing check's error in `cause`; surface it.
    const cause = (error as Error).cause;
    throw new Error(`${(error as Error).message}\n${cause instanceof Error ? cause.message : ''}`, {
      cause: error,
    });
  }
}

/** Every effect x rule decision x unknownRisk, deterministically (rare combinations included). */
export function assertApprovalTable(subjectFor: (config: LegacyConfig) => Authorizer): void {
  for (const unknownRisk of ['allow', 'required'] as const) {
    const config: LegacyConfig = {
      allowLoopback: false,
      allowedPrivateCIDRs: [],
      unknownRisk,
      rules: [],
    };
    const oracle = legacyFor(config);
    const subject = subjectFor(config);
    const requests: AuthorizationRequest[] = [];
    for (const effect of [...EFFECTS, 'unknown'] as const) {
      for (const decision of [undefined, ...MODES]) {
        for (const id of ['rule-0', 'op-1.x']) {
          const rule = decision === undefined ? { id } : { id, decision };
          for (const context of [{ effect }, { effect, rule }]) {
            requests.push({ action: 'act', context }, { action: 'act.unattended', context });
          }
        }
      }
    }
    for (const tenantId of TENANTS) {
      for (const action of CAPABILITIES) {
        requests.push({ action, context: tenantId === undefined ? {} : { tenantId } });
      }
    }
    compare(oracle, subject, requests);
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
      fc.constantFrom(...TENANTS),
      async (config, hosts, addresses, inputs, tenantId) => {
        const oracle = legacyFor(config);
        const subject = subjectFor(config);
        const classify = new ActionRiskPolicy({
          rules: config.rules,
          unknownRisk: config.unknownRisk,
        });
        // Boundaries of every configured CIDR, so prefix errors are always probed.
        const boundaries = config.allowedPrivateCIDRs.flatMap(cidrBoundaries);
        const requests: AuthorizationRequest[] = [
          ...(await egressRequests(hosts, [...addresses, ...boundaries])),
          ...inputs.flatMap((input) => {
            const context = classify.classify(input as Parameters<ActionRiskPolicy['classify']>[0]);
            return [
              { action: 'act', context } as const,
              { action: 'act.unattended', context } as const,
            ];
          }),
          ...CAPABILITIES.map((action) => ({
            action,
            context: tenantId === undefined ? {} : { tenantId },
          })),
        ];
        compare(oracle, subject, requests);
      }
    ),
    {
      numRuns: options.numRuns ?? 300,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    }
  );
}
