/**
 * Compiled request validators (ADR-015 B4).
 *
 * The TypeBox schemas in schemas.ts were the documented source of truth
 * but were never invoked at runtime - every surface hand-rolled its own
 * typeof checks. These compiled validators are the runtime half: surfaces
 * call them instead of re-implementing validation. Compiled once at module
 * load (TypeCompiler), so the per-request cost is a cheap Check().
 */

import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { SessionRequest, SupportedAction } from './types.js';
import { ActionSchema, SessionRequestSchema } from './schemas.js';

/** One validation failure, addressed by pointer path. */
export interface ValidationIssue {
  path: string;
  message: string;
}

export type Validated<T> =
  | { ok: true; value: T }
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
