/**
 * Compiled request validators (ADR-015 B4).
 *
 * The TypeBox schemas in schemas.ts were the documented source of truth
 * but were never invoked at runtime - every surface hand-rolled its own
 * typeof checks. These compiled validators are the runtime half: surfaces
 * call them instead of re-implementing validation. Compiled once at module
 * load (TypeCompiler), so the per-request cost is a cheap Check().
 */

import type { Static, TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import { INTERACTION_GUIDANCE } from './interaction-guidance.js';
import { ActionSchema, PlanStepSchema, SessionRequestSchema } from './schemas.js';
import type { SessionRequest, SupportedAction } from './types.js';

/** One validation failure, addressed by pointer path. */
export interface ValidationIssue {
  path: string;
  message: string;
}

export type Validated<T> =
  | { ok: true; value: T; warnings?: string[] }
  | { ok: false; issues: ValidationIssue[] };

const sessionRequest = TypeCompiler.Compile(SessionRequestSchema);

/**
 * Validate a session-create body against SessionRequestSchema. Note that
 * tenantId is OPTIONAL at the protocol level - whether a tenantId is
 * required is an authentication-policy decision that belongs to the
 * surface (the REST server requires it in no-keys mode and stamps the
 * key's tenant when keys are configured).
 *
 * Additional properties (e.g. the service's flat policy fields) pass
 * through untouched; validation constrains, it does not strip.
 */
export function validateSessionRequest(body: unknown): Validated<SessionRequest> {
  if (sessionRequest.Check(body)) {
    return { ok: true, value: body as SessionRequest };
  }
  const issues: ValidationIssue[] = [];
  for (const error of sessionRequest.Errors(body)) {
    issues.push({ path: error.path, message: error.message });
  }
  return { ok: false, issues };
}

const action = TypeCompiler.Compile(ActionSchema);

/**
 * Validate a constructed action (the protocol's nested SupportedAction
 * shape, not the flat wire body) against the ActionSchema union.
 * Enforced in the service immediately after construction, so REST /act,
 * /plan and direct service callers all pass through one gate.
 */
export function validateAction(body: unknown): Validated<SupportedAction> {
  if (action.Check(body)) {
    return { ok: true, value: body as SupportedAction };
  }
  const issues: ValidationIssue[] = [];
  for (const error of action.Errors(body)) {
    issues.push({ path: error.path, message: error.message });
  }
  return { ok: false, issues };
}

const planStep = TypeCompiler.Compile(PlanStepSchema);

/**
 * Validate one plan step (the flat wire vocabulary) against PlanStepSchema.
 * The plan route was the last request surface taking an unvalidated loose
 * array: waitForLabel/waitMs rode straight through to waitForLabel's
 * deadline arithmetic, where a non-numeric or non-finite waitMs produced a
 * NaN/Infinity deadline and a poll loop that never exited. validateAction
 * does not close this - toProtocolAction strips both fields BEFORE it runs.
 * Like the other validators: constrains, does not strip.
 */
export function validatePlanStep(body: unknown): Validated<Record<string, unknown>> {
  // The nested { action: { type: ... } } envelope is the service-internal
  // representation; left to the compiled union it surfaces as an opaque
  // "Expected union value", so name the flat shape before that check runs.
  if (
    typeof body === 'object' &&
    body !== null &&
    'action' in body &&
    typeof (body as Record<string, unknown>).action !== 'string'
  ) {
    return {
      ok: false,
      issues: [
        {
          path: '/action',
          message:
            "Wire actions and plan steps use the flat shape: { action: 'fill', target: { ref: 'e1_0' }, value: 'text' }. Got a non-string action (nested object?) - flatten it: the action name is the string and every field sits beside it. The nested { action: { type: ... } } shape is the service-internal representation and is not accepted on the wire.",
        },
      ],
    };
  }
  if (planStep.Check(body)) {
    return { ok: true, value: body as Record<string, unknown> };
  }
  const issues: ValidationIssue[] = [];
  for (const error of planStep.Errors(body)) {
    issues.push({ path: error.path, message: error.message });
  }
  return { ok: false, issues };
}

/** One output-boundary policy: invalid reports never prove that a write did not execute. */
export function parseExecutionReport<S extends TSchema>(
  schema: S,
  input: unknown,
  operation: string
): Static<S> {
  if (!Value.Check(schema, input)) {
    throw new Error(`Invalid ${operation} report. ${INTERACTION_GUIDANCE.uncertainWrite}`);
  }
  return input;
}
