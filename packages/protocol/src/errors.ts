/**
 * Error taxonomy and types for AgentBrowser
 */

/**
 * Standard error codes for AgentBrowser API
 */
export enum ErrorCode {
  // Request/Response errors
  INVALID_REQUEST = 'INVALID_REQUEST',
  INVALID_TENANT_ID = 'INVALID_TENANT_ID',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',

  // Policy and approval errors
  POLICY_DENIED = 'POLICY_DENIED',
  APPROVAL_REQUIRED = 'APPROVAL_REQUIRED',

  // Session errors
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_EXPIRED = 'SESSION_EXPIRED',

  // Page errors
  PAGE_NOT_FOUND = 'PAGE_NOT_FOUND',

  // Element reference errors
  STALE_TARGET = 'STALE_TARGET',
  TARGET_NOT_FOUND = 'TARGET_NOT_FOUND',
  TARGET_AMBIGUOUS = 'TARGET_AMBIGUOUS',
  TARGET_NOT_VISIBLE = 'TARGET_NOT_VISIBLE',
  TARGET_DISABLED = 'TARGET_DISABLED',

  // Navigation and action errors
  NAVIGATION_TIMEOUT = 'NAVIGATION_TIMEOUT',
  ACTION_TIMEOUT = 'ACTION_TIMEOUT',
  PLAN_WAIT_TIMEOUT = 'PLAN_WAIT_TIMEOUT',

  // Engine errors
  ENGINE_UNSUPPORTED = 'ENGINE_UNSUPPORTED',
  ENGINE_CRASHED = 'ENGINE_CRASHED',

  // Resource and quota errors
  DOWNLOAD_BLOCKED = 'DOWNLOAD_BLOCKED',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',

  // Output errors
  OUTPUT_TRUNCATED = 'OUTPUT_TRUNCATED',

  // Internal errors
  INTERNAL = 'INTERNAL',
}

/**
 * Error payload describing a single failure.
 *
 * This is the bare detail, not the transport envelope. Use it wherever an
 * error is embedded in a larger successful-shaped response (for example
 * `ActionResult.error`); use `ApiError` for a top-level API failure response.
 */
export interface ApiErrorDetail {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  action?: string;
  details?: Record<string, unknown>;
  traceId?: string;
}

/**
 * Options accepted when constructing an error payload
 */
export interface ApiErrorOptions {
  retryable?: boolean;
  action?: string;
  details?: Record<string, unknown>;
  traceId?: string;
}

/**
 * Standard error envelope for all API responses
 */
export interface ApiError {
  error: ApiErrorDetail;
}

/**
 * Create a bare API error payload (no envelope)
 */
export function createApiErrorDetail(
  code: ErrorCode,
  message: string,
  options: ApiErrorOptions = {}
): ApiErrorDetail {
  const detail: ApiErrorDetail = {
    code,
    message,
    retryable: options.retryable ?? false,
  };

  if (options.action !== undefined) {
    detail.action = options.action;
  }

  if (options.details !== undefined) {
    detail.details = options.details;
  }

  if (options.traceId !== undefined) {
    detail.traceId = options.traceId;
  }

  return detail;
}

/**
 * Create an API error envelope
 */
export function createApiError(
  code: ErrorCode,
  message: string,
  options: ApiErrorOptions = {}
): ApiError {
  return { error: createApiErrorDetail(code, message, options) };
}

/**
 * Check if a response is an error
 */
export function isApiError(response: unknown): response is ApiError {
  if (typeof response !== 'object' || response === null || !('error' in response)) {
    return false;
  }

  const errorObj = (response as ApiError).error;
  return (
    typeof errorObj === 'object' &&
    errorObj !== null &&
    'code' in errorObj &&
    typeof (errorObj as { code: unknown }).code === 'string' &&
    'message' in errorObj &&
    typeof (errorObj as { message: unknown }).message === 'string' &&
    'retryable' in errorObj &&
    typeof (errorObj as { retryable: unknown }).retryable === 'boolean'
  );
}

/**
 * ADR-015: raised by any surface (MCP tool handlers, CLI commands) for
 * input it can reject before touching the service - one declaration
 * instead of per-surface copies.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * ADR-015: one user-facing error formatter shared by the MCP server and
 * the CLI (the copies had already diverged - only the MCP one carried the
 * STALE_TARGET remediation hint). `staleHint` is a surface-appropriate
 * "how to recover" line appended for STALE_TARGET errors.
 */
export function formatErrorForUser(error: unknown, staleHint?: string): string {
  if (error instanceof UsageError) {
    return error.message;
  }

  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    if (code === 'STALE_TARGET' && staleHint) {
      return `${error.message}\n\n${staleHint}`;
    }
    return code && !error.message.startsWith(code) ? `${code}: ${error.message}` : error.message;
  }

  return String(error);
}
