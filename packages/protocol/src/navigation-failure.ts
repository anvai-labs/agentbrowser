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

/** Shared bounded client projection: no adapter prose, addresses or arbitrary details. */
export function navigationFailureDetail(error: unknown): ApiErrorDetail | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    code?: unknown;
    details?: { reason?: unknown; operationId?: unknown };
  };
  const reason = candidate.details?.reason;
  if (!isNavigationFailureReason(reason)) return undefined;
  const code = Object.values(ErrorCode).includes(candidate.code as ErrorCode)
    ? (candidate.code as ErrorCode)
    : ErrorCode.INTERNAL;
  const operationId = candidate.details?.operationId;
  return {
    code,
    message: `Navigation failed: ${reason}`,
    retryable: false,
    details: {
      reason,
      ...(typeof operationId === 'string' && CONTROL_OPERATION_ID.test(operationId)
        ? { operationId }
        : {}),
    },
  };
}
