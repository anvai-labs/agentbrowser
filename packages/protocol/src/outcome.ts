import { type Static, type TString, Type } from '@sinclair/typebox';
import { OperationIdSchema } from './control.js';
import { INTERACTION_GUIDANCE } from './interaction-guidance.js';
import {
  type PlanReport,
  PlanReportSchema,
  createPlanReportParser,
  parsePlanReport,
} from './plan.js';
import { PlanStepSchema } from './schemas.js';
import { parseExecutionReport } from './validators.js';

const strict = { additionalProperties: false };
const identifier = () =>
  Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' });

export const GROUNDING_LAYERS = Object.freeze(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6'] as const);
export const GroundingLayerSchema = Type.Union([
  Type.Literal('G0'),
  Type.Literal('G1'),
  Type.Literal('G2'),
  Type.Literal('G3'),
  Type.Literal('G4'),
  Type.Literal('G5'),
  Type.Literal('G6'),
]);
export type GroundingLayer = (typeof GROUNDING_LAYERS)[number];

export const EvidenceReferenceIdsSchema = Type.Array(identifier(), { maxItems: 32 });
export const VERIFICATION_SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 4096,
  maxBytes: 65_536,
});

export const VerificationProjectionSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('passed'),
      Type.Literal('failed'),
      Type.Literal('unknown'),
      Type.Literal('not_requested'),
    ]),
    verifier: Type.Optional(Type.Object({ id: identifier(), version: identifier() }, strict)),
    requiredLayer: GroundingLayerSchema,
    achievedLayer: Type.Optional(GroundingLayerSchema),
    evidenceRefIds: EvidenceReferenceIdsSchema,
  },
  strict
);
export type VerificationProjection = Static<typeof VerificationProjectionSchema>;

export const OutcomeProjectionSchema = Type.Object(
  {
    availability: Type.Union([
      Type.Literal('available'),
      Type.Literal('blocked'),
      Type.Literal('unsupported'),
    ]),
    execution: Type.Union([
      Type.Literal('not_started'),
      Type.Literal('running'),
      Type.Literal('completed'),
      Type.Literal('failed'),
      Type.Literal('unknown'),
    ]),
    verification: VerificationProjectionSchema,
    cleanup: Type.Union([
      Type.Literal('not_needed'),
      Type.Literal('pending'),
      Type.Literal('complete'),
      Type.Literal('failed'),
      Type.Literal('unknown'),
    ]),
    testedSeam: Type.Union([
      Type.Literal('ui'),
      Type.Literal('application'),
      Type.Literal('agent_tool'),
    ]),
  },
  strict
);
export type OutcomeProjection = Static<typeof OutcomeProjectionSchema>;

const evidenceCorrelationIdSchema: TString = {
  ...OperationIdSchema,
  description:
    'Business receipt operation ID for an opted-in trusted evidence source; distinct from the service operation ID and conveys no authority.',
};

export const OutcomeRunRequestSchema = Type.Object(
  {
    // A UI outcome must exercise the UI seam; an empty plan cannot attest it.
    actions: Type.Array(PlanStepSchema, { minItems: 1 }),
    verification: Type.Object(
      {
        verifier: Type.Object({ id: identifier(), version: identifier() }, strict),
        input: Type.Unknown(),
        evidenceCorrelationId: Type.Optional(evidenceCorrelationIdSchema),
      },
      strict
    ),
  },
  { ...strict, $id: 'urn:agentbrowser:outcome-run-request:v1' }
);
export type OutcomeRunRequest = Static<typeof OutcomeRunRequestSchema>;

export const OutcomeRunReportSchema = Type.Object(
  {
    plan: PlanReportSchema,
    outcome: OutcomeProjectionSchema,
  },
  { ...strict, $id: 'urn:agentbrowser:outcome-run-report:v1' }
);
export type OutcomeRunReport = Static<typeof OutcomeRunReportSchema>;

export const TrustedVerifierDescriptorSchema = Type.Object(
  {
    id: identifier(),
    version: identifier(),
    inputSchemaId: identifier(),
    evidenceSchemaId: identifier(),
    requiredCapability: identifier(),
    evidenceSource: identifier(),
    requiredLayer: GroundingLayerSchema,
    budget: Type.Object(
      {
        maxReads: Type.Integer({ minimum: 1, maximum: 100 }),
        timeoutMs: Type.Integer({ minimum: 1, maximum: 60_000 }),
        pollIntervalMs: Type.Integer({ minimum: 1, maximum: 10_000 }),
        cleanupTimeoutMs: Type.Integer({ minimum: 1, maximum: 60_000 }),
        maxEvidenceRefs: Type.Integer({ minimum: 1, maximum: 32 }),
      },
      strict
    ),
    redaction: Type.Literal('reference_only'),
    unsupported: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 16 }),
    cleanup: Type.Union([Type.Literal('not_needed'), Type.Literal('required')]),
  },
  strict
);
export type TrustedVerifierDescriptor = Static<typeof TrustedVerifierDescriptorSchema>;

const layer = (value: GroundingLayer): number => GROUNDING_LAYERS.indexOf(value);

function validVerification(value: VerificationProjection): boolean {
  if (value.status === 'not_requested')
    return (
      value.verifier === undefined &&
      value.achievedLayer === undefined &&
      value.evidenceRefIds.length === 0
    );
  if (!value.verifier) return false;
  if (value.status === 'unknown') return true;
  if (value.achievedLayer === undefined || value.evidenceRefIds.length === 0) return false;
  return value.status !== 'passed' || layer(value.achievedLayer) >= layer(value.requiredLayer);
}

export function parseOutcomeProjection(input: unknown): OutcomeProjection {
  return parseExecutionReport(
    OutcomeProjectionSchema,
    input,
    'outcome projection',
    (outcome) => validVerification(outcome.verification),
    VERIFICATION_SNAPSHOT_LIMITS
  );
}

export function isPassingOutcome(input: unknown): boolean {
  const outcome = parseOutcomeProjection(input);
  return (
    outcome.availability === 'available' &&
    outcome.execution === 'completed' &&
    outcome.verification.status === 'passed' &&
    outcome.cleanup !== 'pending' &&
    outcome.cleanup !== 'failed' &&
    outcome.cleanup !== 'unknown'
  );
}

export function parseTrustedVerifierDescriptor(input: unknown): TrustedVerifierDescriptor {
  return parseExecutionReport(
    TrustedVerifierDescriptorSchema,
    input,
    'verifier descriptor',
    undefined,
    VERIFICATION_SNAPSHOT_LIMITS
  );
}

export function parseOutcomeRunRequest(input: unknown): OutcomeRunRequest {
  return parseExecutionReport(
    OutcomeRunRequestSchema,
    input,
    'outcome run request',
    undefined,
    VERIFICATION_SNAPSHOT_LIMITS
  );
}

function validRunAxes(plan: PlanReport, outcome: OutcomeProjection): boolean {
  if (plan.ok !== (outcome.execution === 'completed')) return false;
  if (!plan.ok && outcome.execution !== 'failed' && outcome.execution !== 'unknown') {
    const unavailableBeforeExecution =
      outcome.execution === 'not_started' &&
      outcome.availability !== 'available' &&
      plan.completed === 0 &&
      plan.results.length === 0;
    if (!unavailableBeforeExecution) return false;
  }
  return outcome.verification.status !== 'passed' || outcome.execution === 'completed';
}

function invalidOutcomeRunReport(): never {
  throw new Error(`Invalid outcome run report. ${INTERACTION_GUIDANCE.uncertainWrite}`);
}

function parseRunReport(
  input: unknown,
  parsePlan: (input: unknown) => PlanReport,
  verifier?: Readonly<{ id: string; version: string }>
): OutcomeRunReport {
  const report = parseExecutionReport(
    OutcomeRunReportSchema,
    input,
    'outcome run report',
    undefined,
    VERIFICATION_SNAPSHOT_LIMITS
  );

  let plan: PlanReport;
  let outcome: OutcomeProjection;
  try {
    plan = parsePlan(report.plan);
    outcome = parseOutcomeProjection(report.outcome);
  } catch {
    return invalidOutcomeRunReport();
  }

  if (!validRunAxes(plan, outcome)) return invalidOutcomeRunReport();
  if (
    verifier !== undefined &&
    (outcome.verification.verifier?.id !== verifier.id ||
      outcome.verification.verifier.version !== verifier.version)
  ) {
    return invalidOutcomeRunReport();
  }
  return { plan, outcome };
}

export function parseOutcomeRunReport(input: unknown): OutcomeRunReport {
  return parseRunReport(input, parsePlanReport);
}

/** Pin plan verification requirements and verifier identity before any work starts. */
export function createOutcomeRunReportParser(
  request: OutcomeRunRequest
): (input: unknown) => OutcomeRunReport {
  const snapshot = parseOutcomeRunRequest(request);
  const parsePlan = createPlanReportParser(snapshot.actions);
  const verifier = Object.freeze({ ...snapshot.verification.verifier });
  return (input: unknown) => parseRunReport(input, parsePlan, verifier);
}
