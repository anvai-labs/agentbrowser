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
  'SCOPE_LEDGER_UNAVAILABLE',
  'SCOPE_RATE_LIMITED',
] as const);
export type ScopeDenialCode = (typeof SCOPE_DENIAL_CODES)[number];
const scopeCodes = new Set<string>(SCOPE_DENIAL_CODES);

export function isScopeDenialCode(value: unknown): value is ScopeDenialCode {
  return typeof value === 'string' && scopeCodes.has(value);
}

/**
 * The bounded navigation-failure envelope, built from parts. The REST surface
 * (createPage's teardown path) and the client projection (below) share this
 * one constructor so the same blocked navigation can never render one message
 * over REST and another through the CLI/MCP projection of that error.
 */
export function navigationFailureDetailFromParts(input: {
  reason: NavigationFailureReason;
  scope?: ScopeDenialCode;
  scopeDenials?: Record<string, number>;
  code?: ErrorCode;
  operationId?: string;
}): ApiErrorDetail {
  return {
    code: input.code ?? ErrorCode.INTERNAL,
    message: `Navigation failed: ${input.reason}${input.scope !== undefined ? ` (${input.scope})` : ''}`,
    retryable: false,
    details: {
      reason: input.reason,
      ...(input.scopeDenials ? { scopeDenials: input.scopeDenials } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.operationId !== undefined && CONTROL_OPERATION_ID.test(input.operationId)
        ? { operationId: input.operationId }
        : {}),
    },
  };
}

/** Shared bounded client projection: no adapter prose, addresses or arbitrary details. */
export function navigationFailureDetail(error: unknown): ApiErrorDetail | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    code?: unknown;
    details?: { reason?: unknown; operationId?: unknown; scope?: unknown; scopeDenials?: unknown };
  };
  const reason = candidate.details?.reason;
  if (!isNavigationFailureReason(reason)) return undefined;
  const code = Object.values(ErrorCode).includes(candidate.code as ErrorCode)
    ? (candidate.code as ErrorCode)
    : undefined;
  const operationId = candidate.details?.operationId;
  // Read once: a getter must not pass the check and then return something else.
  const scopeValue = candidate.details?.scope;
  const scope = isScopeDenialCode(scopeValue) ? scopeValue : undefined;
  const counts = candidate.details?.scopeDenials;
  const scopeDenials: Record<string, number> = {};
  if (counts && typeof counts === 'object') {
    for (const name of SCOPE_DENIAL_CODES) {
      const count = (counts as Record<string, unknown>)[name];
      if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0)
        scopeDenials[name] = count;
    }
  }
  return navigationFailureDetailFromParts({
    ...(Object.keys(scopeDenials).length ? { scopeDenials } : {}),
    reason,
    ...(code !== undefined ? { code } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(typeof operationId === 'string' ? { operationId } : {}),
  });
}
