import { type Static, Type } from '@sinclair/typebox';
import { type ApiErrorDetail, ErrorCode } from './errors.js';
import { CONTROL_OPERATION_ID } from './operation-id.js';

export const NavigationFailureReasonSchema = Type.Union([
  Type.Literal('dns_nxdomain'),
  Type.Literal('dns_unresolved'),
  Type.Literal('connection_refused'),
  Type.Literal('dns_timeout'),
  Type.Literal('dns_refused'),
  Type.Literal('tls_refused'),
  Type.Literal('egress_policy'),
  Type.Literal('browser_error_document'),
  Type.Literal('engine_error'),
]);
export type NavigationFailureReason = Static<typeof NavigationFailureReasonSchema>;
const reasons = new Set<string>(NavigationFailureReasonSchema.anyOf.map((item) => item.const));

export function isNavigationFailureReason(value: unknown): value is NavigationFailureReason {
  return typeof value === 'string' && reasons.has(value);
}

/**
 * Engagement-scope denial sub-codes (T7, `EngagementScopePolicy`). A scope
 * denial's bounded reason is `egress_policy`; the sub-code says which rule
 * fired, and is the only extra detail the client projection carries.
 */
export const SCOPE_DENIAL_CODES = Object.freeze([
  'SCOPE_HOST_DENIED',
  'SCOPE_PATH_DENIED',
  'SCOPE_METHOD_DENIED',
  'SCOPE_IDENTITY_DENIED',
  'SCOPE_EXPIRED',
  'SCOPE_BUDGET_EXHAUSTED',
] as const);
export type ScopeDenialCode = (typeof SCOPE_DENIAL_CODES)[number];
const scopeCodes = new Set<string>(SCOPE_DENIAL_CODES);

export function isScopeDenialCode(value: unknown): value is ScopeDenialCode {
  return typeof value === 'string' && scopeCodes.has(value);
}

/** Shared bounded client projection: no adapter prose, addresses or arbitrary details. */
export function navigationFailureDetail(error: unknown): ApiErrorDetail | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    code?: unknown;
    details?: { reason?: unknown; operationId?: unknown; scope?: unknown };
  };
  const reason = candidate.details?.reason;
  if (!isNavigationFailureReason(reason)) return undefined;
  const code = Object.values(ErrorCode).includes(candidate.code as ErrorCode)
    ? (candidate.code as ErrorCode)
    : ErrorCode.INTERNAL;
  const operationId = candidate.details?.operationId;
  const scope = isScopeDenialCode(candidate.details?.scope) ? candidate.details.scope : undefined;
  return {
    code,
    message: `Navigation failed: ${reason}${scope !== undefined ? ` (${scope})` : ''}`,
    retryable: false,
    details: {
      reason,
      ...(scope !== undefined ? { scope } : {}),
      ...(typeof operationId === 'string' && CONTROL_OPERATION_ID.test(operationId)
        ? { operationId }
        : {}),
    },
  };
}
