import { type Static, Type } from '@sinclair/typebox';
import { UsageError } from './errors.js';
import { PlanStepSchema } from './schemas.js';
import { parseExecutionReport, validatePlanStep } from './validators.js';

/** Existing wire semantics: an empty plan and additive step fields remain accepted. */
export const PlanActionsSchema = Type.Array(PlanStepSchema);
export const PlanRequestSchema = Type.Object({ actions: PlanActionsSchema });

export const PlanReportSchema = Type.Object(
  {
    ok: Type.Boolean(),
    completed: Type.Integer({ minimum: 0 }),
    results: Type.Array(
      Type.Object({
        step: Type.Integer({ minimum: 0 }),
        ok: Type.Boolean(),
        actionId: Type.Optional(Type.String()),
        remap: Type.Optional(Type.Object({ from: Type.String(), to: Type.String() })),
        result: Type.Optional(Type.Unknown()),
        error: Type.Optional(Type.String()),
      })
    ),
    // Current service always emits these; older SDK/server contracts allow omission.
    mode: Type.Optional(Type.Union([Type.Literal('stable'), Type.Literal('verified')])),
    newRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })),
  },
  { $id: 'urn:agentbrowser:plan-report:v1' }
);
export type PlanReport = Static<typeof PlanReportSchema>;

export function parsePlanSteps(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) throw new UsageError('actions must be an array of plan steps.');
  for (const [index, step] of input.entries()) {
    const validated = validatePlanStep(step);
    if (!validated.ok) {
      const details = validated.issues
        .map((issue) => `actions[${index}]${issue.path}: ${issue.message}`)
        .join('; ');
      throw new UsageError(`Invalid plan step: ${details}`);
    }
  }
  return input;
}

function hasVerifiedFillEvidence(result: unknown): boolean {
  const descriptor =
    typeof result === 'object' && result !== null
      ? Object.getOwnPropertyDescriptor(result, 'verified')
      : undefined;
  return (
    typeof result === 'object' &&
    result !== null &&
    !Array.isArray(result) &&
    Object.getPrototypeOf(result) === Object.prototype &&
    Reflect.ownKeys(result).length === 1 &&
    descriptor !== undefined &&
    Object.hasOwn(descriptor, 'value') &&
    descriptor.value === true
  );
}

function validPlanReport(
  report: PlanReport,
  expectedSteps?: number,
  requiresVerification?: readonly boolean[]
): boolean {
  return (
    !report.ok ||
    (report.error === undefined &&
      report.completed === report.results.length &&
      (expectedSteps === undefined || report.completed === expectedSteps) &&
      report.results.every(
        (result, index) =>
          result.ok &&
          result.step === index &&
          result.error === undefined &&
          (requiresVerification?.[index] !== true || hasVerifiedFillEvidence(result.result))
      ))
  );
}

export function parsePlanReport(input: unknown, expectedSteps?: number): PlanReport {
  return parseExecutionReport(PlanReportSchema, input, 'plan', (report) =>
    validPlanReport(report, expectedSteps)
  );
}

/** Snapshot request-relative verification requirements without retaining private values. */
export function createPlanReportParser(
  actions: readonly Record<string, unknown>[]
): (input: unknown) => PlanReport {
  const expectedSteps = actions.length;
  const requiresVerification = actions.map(
    (action) =>
      action.action === 'fill' &&
      Object.hasOwn(action, 'expectValue') &&
      typeof action.expectValue === 'string'
  );
  return (input: unknown) => {
    const report = parseExecutionReport(PlanReportSchema, input, 'plan', (report) =>
      validPlanReport(report, expectedSteps, requiresVerification)
    );
    return {
      ...report,
      results: report.results.map((result, index) => {
        if (requiresVerification[index] !== true) return result;
        const safeEvidence = report.ok || hasVerifiedFillEvidence(result.result);
        return {
          step: result.step,
          ok: result.ok,
          ...(result.actionId !== undefined ? { actionId: result.actionId } : {}),
          ...(result.remap !== undefined ? { remap: result.remap } : {}),
          ...(safeEvidence ? { result: { verified: true } } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
        };
      }),
    };
  };
}
