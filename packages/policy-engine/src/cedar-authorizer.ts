import { createHash } from 'node:crypto';
import type { ActionRiskClassification } from '@agentbrowser/core';
import {
  CEDAR_SCHEMA,
  CEDAR_SCHEMA_VERSION,
  type PolicyDecision,
  type PolicyDocument,
} from '@agentbrowser/protocol';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import type { AuthorizationRequest, Authorizer, EgressAuthorizationRequest } from './authorizer.js';
import { normalizeSourceForCedar } from './cedar-generator.js';

/**
 * TD-BROWSER-15 phase 3b: an `Authorizer` decided by Cedar, applying every
 * API trap rule from ADR-024 §2:
 *
 * - the document must `validate` successfully in strict mode with zero
 *   validation errors, and every policy id must carry its `@rule` annotation
 *   faithfully (checked at load against the document's own `ruleId`);
 * - ids in the reserved namespaces (`floor.`, `default.`, `engine.`) are
 *   refused at load; `env.` is the generated-document namespace;
 * - every decision runs with `validateRequest: true` against pre-parsed
 *   artifacts (ids derived from the document's version hash);
 * - any thrown error, `type: "failure"`, non-empty `diagnostics.errors`, or
 *   an invalid context is a trap: the authorizer becomes unhealthy, the
 *   decision is deny with `engine.error`, and every later decision denies
 *   until restart (fail closed);
 * - `rulesMatched` carries every deciding id, sorted; `ruleMatched` the first.
 *   An empty deny has no deciding policy and reports `default.deny`.
 *
 * `request.private` is asked once per private source (Cedar's `ip()` takes
 * one address and matches families strictly); the source list must be empty
 * or fully covered, mirroring `LegacyAuthorizer` exactly.
 */

const RESERVED_RULE_PREFIX = /^(floor|default|engine)\./;
const RULE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const DENY_ENGINE: PolicyDecision = Object.freeze({
  allowed: false,
  reason: 'policy engine error; failing closed',
  ruleMatched: 'engine.error',
});
const DENY_DEFAULT: PolicyDecision = Object.freeze({
  allowed: false,
  reason: 'no policy permits this request',
  ruleMatched: 'default.deny',
});

export interface CedarAuthorizerOptions {
  /** The parsed, structurally valid document to load. */
  document: PolicyDocument;
  /**
   * The tenant for requests whose context carries none (TD-15 phase 4).
   * No-keys deployments pass `local`; keyed deployments bind per session and
   * never rely on this default.
   */
  defaultTenant?: string;
}

export class CedarAuthorizer implements Authorizer {
  readonly version: string;
  private readonly defaultTenant: string;
  private readonly policySetId: string;
  private readonly rules: Map<string, string>;
  /** Policies annotated @internal: reported as operator.policy, no reason. */
  private readonly internalIds = new Set<string>();
  private readonly staticPolicies: Record<string, string>;
  private trapReason: string | undefined;

  constructor(options: CedarAuthorizerOptions) {
    const { document } = options;
    this.defaultTenant = options.defaultTenant ?? 'local';
    this.version = documentVersion(document);
    this.policySetId = `set:${this.version}`;
    this.rules = new Map(document.policies.map((policy) => [policy.key, policy.ruleId]));
    this.staticPolicies = Object.fromEntries(
      document.policies.map((policy) => [policy.key, policy.cedar])
    );

    for (const policy of document.policies) {
      if (!RULE_ID.test(policy.ruleId) || RESERVED_RULE_PREFIX.test(policy.ruleId)) {
        throw new Error(`Invalid policy document: rule id ${JSON.stringify(policy.ruleId)}`);
      }
      if (policy.ruleId.startsWith('env.') && document.baseline === undefined) {
        throw new Error(
          `Invalid policy document: env.* rule ${JSON.stringify(policy.ruleId)} without a baseline`
        );
      }
    }

    // Strict validation first: success with validation errors is a refusal.
    const validated = cedar.validate({
      schema: CEDAR_SCHEMA,
      policies: { staticPolicies: this.staticPolicies },
      validationSettings: { mode: 'strict' },
    });
    if (validated.type !== 'success' || validated.validationErrors.length > 0) {
      throw new Error('Invalid policy document: Cedar validation failed');
    }
    // Every policy's @rule annotation must match the document's ruleId;
    // @internal annotations are collected for confidential reporting.
    for (const [key, text] of Object.entries(this.staticPolicies)) {
      const json = cedar.policyToJson(text);
      const annotation =
        json.type === 'success' ? json.json.annotations?.rule?.toString() : undefined;
      if (annotation !== this.rules.get(key)) {
        throw new Error(
          `Invalid policy document: policy ${JSON.stringify(key)} @rule annotation does not match its ruleId`
        );
      }
      if (json.type === 'success' && json.json.annotations?.internal !== undefined) {
        const id = this.rules.get(key);
        if (id !== undefined) this.internalIds.add(id);
      }
    }
    const schema = cedar.preparseSchema(CEDAR_SCHEMA_VERSION, CEDAR_SCHEMA);
    const set = cedar.preparsePolicySet(this.policySetId, {
      staticPolicies: this.staticPolicies,
    });
    if (schema.type !== 'success' || set.type !== 'success') {
      throw new Error('Invalid policy document: Cedar preparse failed');
    }
  }

  /** False once any decision trapped; every decision then denies until restart. */
  get healthy(): boolean {
    return this.trapReason === undefined;
  }

  /** The first trap, for logs; never includes policy content. */
  get trap(): string | undefined {
    return this.trapReason;
  }

  decide(request: AuthorizationRequest): PolicyDecision {
    if (this.trapReason !== undefined) return DENY_ENGINE;
    try {
      switch (request.action) {
        case 'request.private':
          return this.decidePrivate(request);
        case 'request.loopback':
        case 'act':
        case 'act.unattended':
        case 'cdp.attach':
        case 'downloads':
        case 'serviceWorkers':
        case 'cookie.seed':
        case 'cookie.export':
        case 'session.headed':
          return this.ask(request.action, contextFor(request));
      }
    } catch (error) {
      return this.trapped((error as Error).message);
    }
  }

  private decidePrivate(request: EgressAuthorizationRequest): PolicyDecision {
    const { privateSources } = request.context;
    // The vacuous case matches LegacyAuthorizer: nothing to cover, allowed.
    if (privateSources.length === 0) {
      return { allowed: true, reason: 'no private sources', ruleMatched: 'env.allowed-cidrs' };
    }
    let covered = true;
    let decision: PolicyDecision = DENY_DEFAULT;
    for (const source of privateSources) {
      // Family-mismatched sources are refused (BlockList answers false).
      const address = normalizeSourceForCedar(source.address, source.type);
      const answer = this.ask('request.private', {
        ...contextFor(request),
        ip: { __extn: { fn: 'ip', arg: address } },
      });
      if (!answer.allowed) return answer;
      covered = covered && answer.allowed;
      decision = answer;
    }
    return covered ? decision : DENY_DEFAULT;
  }

  private ask(action: string, context: cedar.Context): PolicyDecision {
    // The principal's parent carries the deciding tenant: the session's
    // tenant when the service bound one, else the constructor's default
    // (no-keys deployments use the implicit Tenant::"local").
    const tenant = tenantOf(context) ?? this.defaultTenant;
    const result = cedar.statefulIsAuthorized({
      principal: { type: 'AgentBrowser::Session', id: 'default' },
      action: { type: 'AgentBrowser::Action', id: action },
      resource: { type: 'AgentBrowser::Host', id: 'default' },
      context,
      preparsedSchemaName: CEDAR_SCHEMA_VERSION,
      preparsedPolicySetId: this.policySetId,
      validateRequest: true,
      entities: [
        {
          uid: { type: 'AgentBrowser::Session', id: 'default' },
          attrs: {},
          parents: [{ type: 'AgentBrowser::Tenant', id: tenant }],
        },
        // The tenant entity must exist for `principal in Tenant::"…"`.
        { uid: { type: 'AgentBrowser::Tenant', id: tenant }, attrs: {}, parents: [] },
        { uid: { type: 'AgentBrowser::Host', id: 'default' }, attrs: {}, parents: [] },
      ],
    });
    if (result.type !== 'success') {
      return this.trapped('request rejected');
    }
    const { decision, diagnostics } = result.response;
    if (diagnostics.errors.length > 0) {
      return this.trapped('policy evaluation error');
    }
    const decidingIds = [...new Set(diagnostics.reason.map((key) => this.rules.get(key)))]
      .filter((id): id is string => id !== undefined)
      .sort();
    if (decidingIds.some((id) => this.internalIds.has(id))) {
      // @internal exists for confidentiality (ADR-024): the decision stands,
      // the reason and the deciding rule do not.
      return decision === 'allow'
        ? {
            allowed: true,
            reason: 'operator policy',
            ruleMatched: 'operator.policy',
            rulesMatched: ['operator.policy'],
          }
        : {
            allowed: false,
            reason: 'operator policy',
            ruleMatched: 'operator.policy',
            rulesMatched: ['operator.policy'],
          };
    }
    if (decision === 'allow') {
      const rulesMatched = decidingIds;
      if (rulesMatched.length === 0) return this.trapped('allow without a deciding policy');
      if (rulesMatched[0] === undefined) return this.trapped('allow without a deciding policy');
      return {
        allowed: true,
        reason: 'permitted by policy',
        ruleMatched: rulesMatched[0],
        rulesMatched,
      };
    }
    // Deny reasons carry only forbidding policies; report every deciding id.
    const forbidding = [...new Set(diagnostics.reason.map((key) => this.rules.get(key)))]
      .filter((id): id is string => id !== undefined)
      .sort();
    return forbidding[0] !== undefined
      ? {
          allowed: false,
          reason: 'forbidden by policy',
          ruleMatched: forbidding[0],
          rulesMatched: forbidding,
        }
      : DENY_DEFAULT;
  }

  private trapped(reason: string): PolicyDecision {
    this.trapReason ??= reason;
    return DENY_ENGINE;
  }
}

const ENTITIES = [
  { uid: { type: 'AgentBrowser::Session', id: 'default' }, attrs: {}, parents: [] },
  { uid: { type: 'AgentBrowser::Host', id: 'default' }, attrs: {}, parents: [] },
];

function contextFor(request: AuthorizationRequest): cedar.Context {
  switch (request.action) {
    case 'act':
    case 'act.unattended':
      return actContext(request.context);
    case 'request.loopback':
    case 'request.private': {
      const { phase, target, addressClasses, tenantId } = request.context;
      return {
        phase,
        target,
        addressClasses: [...addressClasses],
        ...(tenantId !== undefined ? { tenantId } : {}),
      };
    }
    default: {
      const { tenantId } = request.context;
      return tenantId === undefined ? {} : { tenantId };
    }
  }
}

/** The tenant a context carries, if any (capability and bound-egress contexts). */
function tenantOf(context: Record<string, unknown>): string | undefined {
  const tenantId = context.tenantId;
  return typeof tenantId === 'string' && tenantId !== '' ? tenantId : undefined;
}

function actContext(
  classification: ActionRiskClassification & { tenantId?: string }
): cedar.Context {
  return {
    effect: classification.effect,
    matchedRule: classification.rule?.id ?? 'none',
    ...(classification.tenantId !== undefined ? { tenantId: classification.tenantId } : {}),
  };
}

/** The document's version: a SHA-256 over its canonical form, baseline included. */
export function documentVersion(document: PolicyDocument): string {
  const canonical = JSON.stringify({
    version: document.version,
    ...(document.baseline !== undefined ? { baseline: document.baseline } : {}),
    unknownRisk: document.unknownRisk,
    approvalRules: document.approvalRules,
    policies: document.policies.map((policy) => [policy.key, policy.ruleId, policy.cedar]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
