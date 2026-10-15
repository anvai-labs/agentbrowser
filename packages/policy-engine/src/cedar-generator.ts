import { isIP } from 'node:net';
import { type ActionRiskRule, validateActionRiskRules } from '@agentbrowser/core';
import type { ExportedApprovalRule, PolicyDocument } from '@agentbrowser/protocol';

/**
 * TD-BROWSER-15 phase 3: turn today's environment configuration into a Cedar
 * policy set that decides exactly as `LegacyAuthorizer` does — proven by the
 * phase-2 differential oracle. Deterministic: the same configuration always
 * produces byte-identical text, so documents diff cleanly.
 *
 * Two Cedar behaviours shape the output (verified against the pinned
 * `@cedar-policy/cedar-wasm` 4.13):
 * - `isInRange` never matches across families, and `ip()` rejects
 *   IPv4-mapped literals. So mapped sources are normalized to IPv4 before a
 *   request is built, and mapped-space operator CIDRs are emitted as their
 *   IPv4 equivalents.
 * - The wasm build has no set quantifiers. So `request.private` is asked once
 *   per private source with a single optional `ip`, and the caller conjoins.
 */

/** The environment-derived configuration a document is generated from. */
export interface CedarGenerationConfig {
  /** `AGENTBROWSER_APPROVAL_POLICY.unknownRisk`; default `allow`. */
  unknownRisk?: 'allow' | 'required';
  /** `AGENTBROWSER_ALLOW_LOOPBACK`; default false. */
  allowLoopback?: boolean;
  /** `AGENTBROWSER_ALLOWED_CIDRS`; default none. Same strict syntax as NetworkPolicy. */
  allowedPrivateCIDRs?: string[];
  /** The operator approval rules, as `ActionRiskPolicy` accepts them. */
  rules?: readonly ActionRiskRule[];
}

/** One generated policy: a unique key, its `env.*` rule id, and its text. */
export interface GeneratedCedarPolicy {
  readonly key: string;
  readonly ruleId: string;
  readonly cedar: string;
}

const ACT = 'AgentBrowser::Action::"act"';
const UNATTENDED = 'AgentBrowser::Action::"act.unattended"';
const ACT_SCOPE = `action in [${ACT}, ${UNATTENDED}]`;
const HIGH_RISK_EFFECTS = ['transaction', 'account-security', 'external-message', 'destructive'];
const CAPABILITY_ACTIONS = [
  'cdp.attach',
  'downloads',
  'serviceWorkers',
  'cookie.seed',
  'cookie.export',
  'session.headed',
  // TD-BROWSER-16 phase 6: today's env has no handoff rule; a policy file
  // can deny per domain (the env document grants, mirroring the legacy
  // authorizer's env.handoff.default).
  'cookie.handoff',
];

const quoted = (values: readonly string[]) =>
  `[${values.map((v) => JSON.stringify(v)).join(', ')}]`;
const effectSet = (effects: readonly string[]) => `${quoted(effects)}.contains(context.effect)`;

class Emitter {
  private seq = 0;
  readonly policies: GeneratedCedarPolicy[] = [];

  /** `@rule` carries the reported id; paired policies may share one rule id. */
  add(ruleId: string, body: string): void {
    this.policies.push({
      key: `${ruleId}#${++this.seq}`,
      ruleId,
      cedar: `@rule(${JSON.stringify(ruleId)}) ${body};`,
    });
  }
}

/** One approval outcome: allow covers both asks, required splits them, deny forbids both. */
function addMode(
  emitter: Emitter,
  ruleId: string,
  condition: string,
  mode: 'allow' | 'required' | 'deny'
): void {
  if (mode === 'deny') {
    emitter.add(ruleId, `forbid(principal, ${ACT_SCOPE}, resource) when { ${condition} }`);
    return;
  }
  // 'allow' covers both asks; anything else (only 'required' can reach here)
  // splits them — so an unrecognized mode could only ever fail closed.
  const scope = mode === 'allow' ? ACT_SCOPE : `action == ${ACT}`;
  emitter.add(ruleId, `permit(principal, ${scope}, resource) when { ${condition} }`);
  emitter.add(
    ruleId,
    mode === 'allow'
      ? `permit(principal, action == ${UNATTENDED}, resource) when { ${condition} }`
      : `forbid(principal, action == ${UNATTENDED}, resource) when { ${condition} }`
  );
}

/**
 * The policy set for a configuration. Rule matching itself stays in
 * `ActionRiskPolicy` (first match, hostname case); the generated policies key
 * on the matched rule id, and the default branches on "the matched rule has
 * no decision of its own".
 */
export function cedarPolicySetFromLegacyConfig(
  config: CedarGenerationConfig
): GeneratedCedarPolicy[] {
  // Review 3a: rule ids are interpolated into Cedar text, so the generator
  // validates exactly what ActionRiskPolicy validates at startup — one shared
  // validator — and can never be fed rules the rest of the system rejects.
  validateActionRiskRules(config.rules);
  if (config.unknownRisk !== undefined && !['allow', 'required'].includes(config.unknownRisk))
    throw new Error('Invalid operator approval policy');
  const emitter = new Emitter();

  // Loopback: today a single flag decides; the paired id names the outcome.
  if (config.allowLoopback) {
    emitter.add(
      'env.allow-loopback',
      'permit(principal, action == AgentBrowser::Action::"request.loopback", resource)'
    );
  } else {
    emitter.add(
      'env.block-loopback',
      'forbid(principal, action == AgentBrowser::Action::"request.loopback", resource)'
    );
  }

  // Private: every source must be inside an operator CIDR (asked per source).
  const ranges = expandRangesForCedar(config.allowedPrivateCIDRs ?? []);
  if (ranges.length > 0) {
    const cover = `context has ip && (${ranges.map((r) => `context.ip.isInRange(ip("${r}"))`).join(' || ')})`;
    emitter.add(
      'env.allowed-cidrs',
      `permit(principal, action == AgentBrowser::Action::"request.private", resource) when { ${cover} }`
    );
    emitter.add(
      'env.block-private',
      `forbid(principal, action == AgentBrowser::Action::"request.private", resource) unless { ${cover} }`
    );
  } else {
    emitter.add(
      'env.block-private',
      'forbid(principal, action == AgentBrowser::Action::"request.private", resource)'
    );
  }

  // Approval: one branch per rule that carries a decision, keyed on its id.
  const rules = config.rules ?? [];
  const decidedIds: string[] = [];
  rules.forEach((rule, index) => {
    const id = rule.id ?? `rule-${index}`;
    if (rule.decision === undefined) return;
    decidedIds.push(id);
    addMode(
      emitter,
      `env.approval.${id}`,
      `context.matchedRule == ${JSON.stringify(id)}`,
      rule.decision
    );
  });

  // Defaults: apply when the matched rule has no decision of its own. Cedar
  // forbids empty set literals, so with no decided rules there is nothing to
  // exclude and the clause is omitted.
  const noDecision = decidedIds.length
    ? `!(${quoted(decidedIds)}.contains(context.matchedRule)) && `
    : '';
  addMode(
    emitter,
    'env.approval.unknown-risk',
    `${noDecision}context.effect == "unknown"`,
    config.unknownRisk ?? 'allow'
  );
  addMode(
    emitter,
    'env.approval.high-risk',
    `${noDecision}${effectSet(HIGH_RISK_EFFECTS)}`,
    'required'
  );
  addMode(
    emitter,
    'env.approval.default',
    `${noDecision}!(${effectSet([...HIGH_RISK_EFFECTS, 'unknown'])})`,
    'allow'
  );

  // Capabilities: today every request is granted.
  emitter.add(
    'env.capability.default',
    `permit(principal, action in [${CAPABILITY_ACTIONS.map((a) => `AgentBrowser::Action::"${a}"`).join(', ')}], resource)`
  );

  return emitter.policies;
}

/**
 * A document from today's environment variables, parsed exactly as the
 * service parses them (`networkPolicyFromEnvironment` and the approval
 * policy option): operators migrate to a policy file by generating it, not by
 * hand-writing one. Invalid values throw with the same messages startup uses.
 */
export function policyDocumentFromEnvironment(
  env: {
    AGENTBROWSER_ALLOWED_CIDRS?: string | undefined;
    AGENTBROWSER_ALLOW_LOOPBACK?: string | undefined;
    AGENTBROWSER_APPROVAL_POLICY?: string | undefined;
  } = process.env
): PolicyDocument {
  const raw = env.AGENTBROWSER_ALLOWED_CIDRS?.trim() ?? '';
  const parsed =
    env.AGENTBROWSER_APPROVAL_POLICY !== undefined
      ? JSON.parse(env.AGENTBROWSER_APPROVAL_POLICY)
      : {};
  // The service passes this value to `new ActionRiskPolicy`, which refuses a
  // non-object policy and non-array rules at startup; the document must not
  // represent a configuration the server would refuse to boot (review 3b F1).
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid operator approval policy');
  const approval = parsed as Record<string, unknown>;
  validateActionRiskRules(
    approval.rules === undefined ? undefined : (approval.rules as ActionRiskRule[])
  );
  return policyDocumentFromLegacyConfig({
    allowLoopback: /^(1|true|yes)$/i.test(env.AGENTBROWSER_ALLOW_LOOPBACK?.trim() ?? ''),
    allowedPrivateCIDRs: raw === '' ? [] : raw.split(',').map((cidr) => cidr.trim()),
    ...(approval.unknownRisk !== undefined
      ? { unknownRisk: approval.unknownRisk as 'allow' | 'required' }
      : {}),
    ...(approval.rules !== undefined ? { rules: approval.rules as ActionRiskRule[] } : {}),
  });
}

/** A document ready for `policy export`: the set plus the config it came from. */
export function policyDocumentFromLegacyConfig(config: CedarGenerationConfig): PolicyDocument {
  const approvalRules: ExportedApprovalRule[] = (config.rules ?? []).map((rule) => ({
    ...('id' in rule && rule.id !== undefined ? { id: rule.id } : {}),
    effect: rule.effect,
    ...(rule.hostname !== undefined ? { hostname: rule.hostname } : {}),
    ...(rule.action !== undefined ? { action: rule.action } : {}),
    ...(rule.role !== undefined ? { role: rule.role } : {}),
    ...(rule.name !== undefined ? { name: rule.name } : {}),
    ...(rule.decision !== undefined ? { decision: rule.decision } : {}),
  }));
  return {
    version: 'agentbrowser-policy/v1',
    baseline: 'agentbrowser:baseline/v1',
    unknownRisk: config.unknownRisk ?? 'allow',
    approvalRules,
    policies: cedarPolicySetFromLegacyConfig(config),
  };
}

// ---------------------------------------------------------------------------
// CIDR expansion: mirror `BlockList`'s cross-family behaviour in Cedar terms
// ---------------------------------------------------------------------------

interface ParsedCidr {
  subnet: string;
  prefix: number;
  family: 4 | 6;
}

/** The same grammar `compilePrivateCIDRs` accepts; rejects the same input. */
export function parseCidr(cidr: string): ParsedCidr {
  const match = typeof cidr === 'string' ? /^([^/%]+)\/(0|[1-9]\d*)$/.exec(cidr) : null;
  const subnet = match?.[1] ?? '';
  const family = isIP(subnet);
  const prefix = Number(match?.[2]);
  if (
    match?.[0] !== cidr ||
    (family !== 4 && family !== 6) ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > (family === 4 ? 32 : 128)
  ) {
    throw new Error('Invalid allowedPrivateCIDRs CIDR: expected an IP address and valid prefix');
  }
  return { subnet, prefix, family };
}

/** `::ffff:0:0/96` as a number: the marker every mapped address shares. */
const MAPPED_MARKER = 0xffffn << 32n;
const isMappedSpace = (value: bigint) => value >> 32n === MAPPED_MARKER >> 32n;
const ALL_V4 = '0.0.0.0/0';

function v6ToBigInt(address: string): bigint {
  // A trailing IPv4 group stands for its two hex words (::ffff:10.0.0.0).
  const expand = (part: string[]) =>
    part.flatMap((word) => {
      if (!word.includes('.')) return [word];
      const hex = (word.match(/[^.]+/g) ?? [])
        .map((octet) => Number(octet).toString(16).padStart(2, '0'))
        .join('');
      return [hex.slice(0, 4).padStart(4, '0'), hex.slice(4).padEnd(4, '0')];
    });
  const [headText, tailText] = address.split('::');
  const head = expand(headText === undefined || headText === '' ? [] : headText.split(':'));
  const tail = expand(tailText === undefined || tailText === '' ? [] : tailText.split(':'));
  const fill = tailText !== undefined ? Array<string>(8 - head.length - tail.length).fill('0') : [];
  return [...head, ...fill, ...tail]
    .slice(0, 8)
    .reduce((acc, word) => (acc << 16n) | BigInt(Number.parseInt(word, 16)), 0n);
}

const v4Of = (low: bigint) =>
  [
    Number((low >> 24n) & 0xffn),
    Number((low >> 16n) & 0xffn),
    Number((low >> 8n) & 0xffn),
    Number(low & 0xffn),
  ].join('.');

/**
 * The IPv4 range an IPv6 rule grants: `BlockList` checks an IPv4 address as
 * its `::ffff:a.b.c.d` form against IPv6 rules, which is pure prefix math.
 * Every IPv4 shares the marker's top 96 bits, so a prefix up to 96 grants
 * either all of IPv4 (marker agreement) or nothing; a longer prefix must
 * agree with the marker exactly and then constrains the embedded IPv4.
 */
function v4RangeOfV6Rule(value: bigint, prefix: number): string | undefined {
  if (prefix <= 96) {
    const shift = BigInt(128 - prefix);
    return value >> shift === MAPPED_MARKER >> shift ? ALL_V4 : undefined;
  }
  if (value >> 32n !== MAPPED_MARKER >> 32n) return undefined;
  const v4Prefix = prefix - 96;
  const mask = v4Prefix === 0 ? 0n : 0xffffffffn << BigInt(32 - v4Prefix);
  return `${v4Of(value & 0xffffffffn & mask)}/${v4Prefix}`;
}

/**
 * Cedar ranges standing for the operator CIDRs: IPv4 rules as-is, genuine
 * IPv6 rules as-is plus the IPv4 range they grant through BlockList's mapped
 * check, and mapped-space rules as their IPv4 equivalents (a mapped literal
 * is never sent to Cedar).
 */
export function expandRangesForCedar(cidrs: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (range: string) => {
    if (!seen.has(range)) {
      seen.add(range);
      out.push(range);
    }
  };
  for (const cidr of cidrs) {
    const { subnet, prefix, family } = parseCidr(cidr);
    if (family === 4) {
      push(cidr);
      continue;
    }
    const value = v6ToBigInt(subnet);
    // A rule of /96 or longer whose address is in the mapped space covers
    // only mapped addresses, and every mapped source is normalized to IPv4
    // before it reaches Cedar — so only the IPv4 range stands in.
    const onlyMapped = prefix >= 96 && isMappedSpace(value);
    if (!onlyMapped) push(cidr);
    const granted = v4RangeOfV6Rule(value, prefix);
    if (granted !== undefined) push(granted);
  }
  return out;
}

/**
 * Normalize one private source for a Cedar request. Mapped-space IPv6
 * (`::ffff:a.b.c.d`, and the hex form of the same range) is sent as its IPv4
 * address, which is also how BlockList matches it; everything else is sent as
 * written. Throws on input that is not an address.
 */
export function normalizeSourceForCedar(address: string, type: 'ipv4' | 'ipv6'): string {
  const family = isIP(address);
  // Review 3a: a family-mismatched pair would be granted by the Cedar side
  // where BlockList answers false, so it is refused rather than guessed.
  if (family === 0 || (type === 'ipv4' ? family !== 4 : family !== 6))
    throw new Error(`not a valid ${type} address: ${JSON.stringify(address)}`);
  if (type === 'ipv4') return address;
  const value = v6ToBigInt(address);
  if (isMappedSpace(value)) return v4Of(value & 0xffffffffn);
  return address;
}
