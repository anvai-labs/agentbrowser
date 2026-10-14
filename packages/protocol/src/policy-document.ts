import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * The Cedar contract for operator policy (TD-BROWSER-15 phase 3, ADR-024):
 * the schema text every policy set — generated or operator-written — must
 * validate against in strict mode, and the JSON document that carries a
 * policy set plus the configuration it was derived from.
 *
 * The schema text is the versioned artifact; docs and fixtures are generated
 * from it, never the other way around.
 */

/** Identifies the Cedar schema below; stamped on generated documents. */
export const CEDAR_SCHEMA_VERSION = 'agentbrowser-cedar/v1';

/**
 * The AgentBrowser Cedar schema. Action ids are the `Authorizer` action ids;
 * `request.private` carries one normalized source address per ask (the
 * caller asks once per private source and conjoins), because Cedar's `ip`
 * extension has no cross-family matching and the pinned wasm build has no
 * set quantifiers.
 */
export const CEDAR_SCHEMA = `namespace AgentBrowser {
  entity Tenant;

  entity Session in [Tenant] = {
    engine?: String,
    cdpAttach?: Bool,
    controlMode?: String,
    headless?: Bool,
  };

  entity Host = {
    domain?: String,
  };

  action "request", "request.loopback" appliesTo {
    principal: [Session],
    resource: [Host],
    context: { phase: String, target: String, addressClasses: Set<String> },
  };

  action "request.private" appliesTo {
    principal: [Session],
    resource: [Host],
    context: { phase: String, target: String, addressClasses: Set<String>, ip?: ipaddr },
  };

  action "act", "act.unattended" appliesTo {
    principal: [Session],
    resource: [Host],
    context: {
      effect: String,
      matchedRule: String,
      hostname?: String,
      action?: String,
      role?: String,
      name?: String,
    },
  };

  action "cdp.attach", "downloads", "serviceWorkers", "cookie.seed", "cookie.export", "session.headed" appliesTo {
    principal: [Session],
    resource: [Host],
    context: { tenantId?: String },
  };
}`;

/** One approval rule as exported into a document: an `ActionRiskRule` copy. */
export const ExportedApprovalRuleSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    hostname: Type.Optional(Type.String({ maxLength: 200 })),
    action: Type.Optional(Type.String({ maxLength: 200 })),
    role: Type.Optional(Type.String({ maxLength: 200 })),
    name: Type.Optional(Type.String({ maxLength: 200 })),
    effect: Type.Union([
      Type.Literal('read'),
      Type.Literal('write-local'),
      Type.Literal('transaction'),
      Type.Literal('account-security'),
      Type.Literal('external-message'),
      Type.Literal('destructive'),
    ]),
    decision: Type.Optional(
      Type.Union([Type.Literal('allow'), Type.Literal('required'), Type.Literal('deny')])
    ),
  },
  { additionalProperties: false }
);
export type ExportedApprovalRule = Static<typeof ExportedApprovalRuleSchema>;

/** One Cedar policy: its unique key, the rule id it decides for, and its text. */
export const CedarPolicySchema = Type.Object(
  {
    /** Unique within the document; used as the Cedar policy id. */
    key: Type.String({ minLength: 1, maxLength: 128 }),
    /** The `env.*` / operator rule id this policy decides for, from `@rule`. */
    ruleId: Type.String({ minLength: 1, maxLength: 128 }),
    cedar: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type CedarPolicy = Static<typeof CedarPolicySchema>;

/**
 * Operator limits a policy file may carry (TD-BROWSER-15 phase 4). These are
 * the embedder options the stock entrypoint stops passing when a file is set;
 * an unknown key is a startup refusal, not a silent ignore.
 */
export const PolicyLimitsSchema = Type.Object(
  {
    extractMaxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 * 1024 * 1024 })),
    maxResponseBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 * 1024 * 1024 })),
  },
  { additionalProperties: false }
);
export type PolicyLimits = Static<typeof PolicyLimitsSchema>;

/** A complete policy document: the unit `policy export` writes and phase 4 loads. */
export const PolicyDocumentSchema = Type.Object(
  {
    version: Type.Literal('agentbrowser-policy/v1'),
    /** The baseline the document was generated from, if any. */
    baseline: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    unknownRisk: Type.Union([Type.Literal('allow'), Type.Literal('required')]),
    approvalRules: Type.Array(ExportedApprovalRuleSchema, { maxItems: 1000 }),
    policies: Type.Array(CedarPolicySchema, { maxItems: 4096 }),
    limits: Type.Optional(PolicyLimitsSchema),
  },
  { additionalProperties: false }
);
export type PolicyDocument = Static<typeof PolicyDocumentSchema>;

/**
 * Parses an untrusted document. Structural only: Cedar validation (strict
 * mode against `CEDAR_SCHEMA`, annotation well-formedness, reserved rule-id
 * prefixes) happens when the document is loaded, not here.
 */
export function parsePolicyDocument(input: unknown): PolicyDocument {
  if (!Value.Check(PolicyDocumentSchema, input)) {
    const error = [...Value.Errors(PolicyDocumentSchema, input)][0];
    throw new Error(
      `Invalid policy document: ${error ? `${error.path} ${error.message}` : 'wrong shape'}`
    );
  }
  const document = input;
  const keys = new Set<string>();
  for (const policy of document.policies) {
    if (keys.has(policy.key))
      throw new Error(`Invalid policy document: duplicate key ${policy.key}`);
    keys.add(policy.key);
  }
  return document;
}
