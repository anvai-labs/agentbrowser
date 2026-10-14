import { classifyIPAddress, isMetadataHostname } from '@agentbrowser/policy';
import type { PolicyDecision } from '@agentbrowser/protocol';
import type { Authorizer, CapabilityAction } from './authorizer.js';

/**
 * TD-BROWSER-15 phase 5: the query surface's decision engine. `policy check`
 * answers without DNS: an IP literal is classified by the real classifier and
 * answered exactly as enforcement would answer it; a hostname first passes
 * the name-level rules (metadata names are floor-denied, loopback names ask
 * the loopback question) and then gets one answer per class set the
 * classifier can produce — the non-public sets depend on the resolved
 * address, and say so instead of guessing.
 *
 * Works against any `Authorizer`, so the no-file route answers through
 * `LegacyAuthorizer` by exactly the same enumeration as a loaded policy.
 */

export type CheckAction =
  | 'request'
  | 'request.loopback'
  | 'request.private'
  | 'act'
  | 'act.unattended'
  | CapabilityAction;

export interface PolicyCheckRequest {
  action: CheckAction;
  /** An IP literal or a hostname; never resolved. */
  target?: string;
  /** Declared act context (effect, matchedRule). */
  context?: { effect?: string; matchedRule?: string };
  /** The tenant the question is asked for: the caller's authenticated one. */
  tenantId?: string;
}

export interface PolicyCheckSetAnswer {
  /** The class set this answer covers (`public`, `loopback`, …). */
  classSet: string;
  answer: { kind: 'decision'; decision: PolicyDecision } | { kind: 'depends-on-resolution' };
}

export type PolicyCheckAnswer = PolicyCheckSetAnswer[];

/** The reporting id for a fact of the floor, not an authorizer rule. */
const FLOOR_PUBLIC: PolicyDecision = Object.freeze({
  allowed: true,
  reason: 'public addresses are not blocked by the floor',
  ruleMatched: 'floor.public',
});
const FLOOR_INVALID_IP: PolicyDecision = Object.freeze({
  allowed: false,
  reason: 'not a valid IP literal or hostname',
  ruleMatched: 'floor.invalid-ip',
});
const FLOOR_METADATA: PolicyDecision = Object.freeze({
  allowed: false,
  reason: 'cloud metadata endpoints are blocked by the floor',
  ruleMatched: 'floor.metadata',
});

/** Answers one check request by enumeration, never by resolution. */
export function policyCheck(
  authorizer: Authorizer,
  request: PolicyCheckRequest
): PolicyCheckAnswer {
  const tenant = request.tenantId === undefined ? undefined : { tenantId: request.tenantId };

  if (request.action === 'act' || request.action === 'act.unattended') {
    const classification = {
      effect: (request.context?.effect ?? 'unknown') as never,
      ...(request.context?.matchedRule !== undefined
        ? { rule: { id: request.context.matchedRule } }
        : {}),
      ...tenant,
    };
    return [
      {
        classSet: 'act',
        answer: {
          kind: 'decision',
          decision: authorizer.decide({ action: request.action, context: classification }),
        },
      },
    ];
  }

  if (isCapability(request.action)) {
    return [
      {
        classSet: 'capability',
        answer: {
          kind: 'decision',
          decision: authorizer.decide({
            action: request.action,
            context: request.tenantId === undefined ? {} : { tenantId: request.tenantId },
          }),
        },
      },
    ];
  }

  const target = request.target ?? '';
  const bare = target.replace(/^\[|\]$/g, '');
  // Refuse what enforcement refuses (review finding 4): a caller-supplied
  // prefix length, and IP-literal-SHAPED text that does not classify — the
  // dotted-quad and bracket/percent guards mirror NetworkPolicy.checkHostname.
  if (target.includes('/')) {
    return [{ classSet: 'invalid', answer: { kind: 'decision', decision: FLOOR_INVALID_IP } }];
  }
  const classification = classifyIPAddress(bare);
  // Colon/bracket/percent forms that do not classify, and dotted-quad shapes
  // that do not (leading zeroes are ambiguous; URL callers normalize). The
  // quad guard is exactly four groups, mirroring NetworkPolicy's regex —
  // 1.2.3 and 1.2.3.4.5 remain hostnames (review round 2, B).
  if (classification === undefined && (/[:[\]%]/.test(target) || /^\d+(\.\d+){3}$/.test(target))) {
    return [{ classSet: 'invalid', answer: { kind: 'decision', decision: FLOOR_INVALID_IP } }];
  }

  if (classification === undefined) {
    // A hostname (or empty): name-level rules first.
    if (target !== '' && isMetadataHostname(bare.toLowerCase())) {
      return [{ classSet: 'name', answer: { kind: 'decision', decision: FLOOR_METADATA } }];
    }
    const nameLevel = nameLevelDecision(authorizer, request, bare, tenant);
    if (nameLevel !== undefined)
      return [{ classSet: 'name', answer: { kind: 'decision', decision: nameLevel } }];
    // The class sets the classifier can produce for a resolved address. The
    // public set needs no address; the others genuinely depend on it.
    return [
      { classSet: 'public', answer: { kind: 'decision', decision: FLOOR_PUBLIC } },
      { classSet: 'loopback', answer: { kind: 'depends-on-resolution' } },
      { classSet: 'private', answer: { kind: 'depends-on-resolution' } },
      { classSet: 'loopback+private', answer: { kind: 'depends-on-resolution' } },
    ];
  }

  // An IP literal: classified for real, answered as enforcement would.
  if (classification.metadata) {
    return [{ classSet: 'literal', answer: { kind: 'decision', decision: FLOOR_METADATA } }];
  }
  const classes: Array<'loopback' | 'private'> = [
    ...(classification.loopback ? (['loopback'] as const) : []),
    ...(classification.privateIP && classification.privateSources.length > 0
      ? (['private'] as const)
      : []),
  ];
  const setLabel = classes.join('+') || 'public';
  if (classes.length === 0) {
    return [{ classSet: setLabel, answer: { kind: 'decision', decision: FLOOR_PUBLIC } }];
  }
  const decision =
    request.action === 'request.loopback' && !classification.loopback
      ? { allowed: false, reason: 'not a loopback address', ruleMatched: 'env.block-loopback' }
      : literalDecision(authorizer, request, classification, classes, tenant);
  return [{ classSet: setLabel, answer: { kind: 'decision', decision } }];
}

type Classification = NonNullable<ReturnType<typeof classifyIPAddress>>;

/**
 * The enforcement ask for a classified literal, mirrored exactly: phase
 * `hostname` (the literal IS the hostname), the FULL computed class set, and
 * every private source at once — the authorizer performs the per-source
 * split. Policies conditioning on phase or addressClasses therefore see the
 * same context from check as from enforcement (review finding 3).
 */
function literalDecision(
  authorizer: Authorizer,
  request: PolicyCheckRequest,
  classification: Classification,
  classes: Array<'loopback' | 'private'>,
  tenant: { tenantId: string } | undefined
): PolicyDecision {
  const context = {
    phase: 'hostname' as const,
    // The target exactly as the caller gave it — brackets included — matching
    // what NetworkPolicy.checkHostname passes through (review round 2, A).
    target: request.target ?? classification.address,
    addressClasses: classes,
    privateSources: classification.privateSources,
    ...(tenant ?? {}),
  };
  if (classes.includes('loopback')) {
    const loopback = authorizer.decide({ action: 'request.loopback', context });
    if (!loopback.allowed) return loopback;
  }
  if (classes.includes('private')) {
    return authorizer.decide({ action: 'request.private', context });
  }
  return FLOOR_PUBLIC;
}

/**
 * Name-level answers: a loopback NAME asks the loopback question at the
 * hostname phase. Other names have no name-level answer (the sets follow).
 */
function nameLevelDecision(
  authorizer: Authorizer,
  request: PolicyCheckRequest,
  hostname: string,
  tenant: { tenantId: string } | undefined
): PolicyDecision | undefined {
  const named =
    hostname !== '' &&
    classifyIPAddress(hostname) === undefined &&
    /^(localhost|localhost\.localdomain)$/i.test(hostname);
  if (!named) return undefined;
  if (request.action === 'request.private') return undefined;
  return authorizer.decide({
    action: 'request.loopback',
    context: {
      phase: 'hostname',
      target: hostname,
      addressClasses: ['loopback'],
      privateSources: [],
      ...(tenant ?? {}),
    },
  });
}

function isCapability(action: CheckAction): action is CapabilityAction {
  return (
    action === 'cdp.attach' ||
    action === 'downloads' ||
    action === 'serviceWorkers' ||
    action === 'cookie.seed' ||
    action === 'cookie.export' ||
    action === 'session.headed'
  );
}
