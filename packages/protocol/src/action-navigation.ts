import { type Static, Type } from '@sinclair/typebox';
import { isScopeDenialCode, SCOPE_DENIAL_CODES } from './navigation-failure.js';

/** Temporal evidence only: not proof that the action caused the navigation. */
export const ActionNavigationObservationSchema = Type.Object(
  {
    status: Type.Literal('blocked'),
    reason: Type.Literal('egress_policy'),
    scope: Type.Union(SCOPE_DENIAL_CODES.map((code) => Type.Literal(code))),
    observedDuring: Type.Literal('action'),
  },
  { additionalProperties: false }
);
export type ActionNavigationObservation = Static<typeof ActionNavigationObservationSchema>;

/** Bounded projection: never carry URL, redirect chain, driver prose or other data. */
export function parseActionNavigationObservation(
  value: unknown
): ActionNavigationObservation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const candidate = value as Record<string, unknown>;
    const status = candidate.status;
    const reason = candidate.reason;
    const scope = candidate.scope;
    const observedDuring = candidate.observedDuring;
    if (
      status !== 'blocked' ||
      reason !== 'egress_policy' ||
      observedDuring !== 'action' ||
      !isScopeDenialCode(scope)
    )
      return undefined;
    return { status, reason, scope, observedDuring };
  } catch {
    return undefined;
  }
}
