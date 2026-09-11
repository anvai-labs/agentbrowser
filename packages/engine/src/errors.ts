import { type ApiErrorDetail, ErrorCode } from '@agentbrowser/protocol';

export type ProtocolErrorCode = `${ErrorCode}`;

/** Adapter failures carry machine-readable semantics across every operation. */
export class EngineError extends Error {
  constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

const codes = new Set<string>(Object.values(ErrorCode));

/** One compatibility boundary for older adapters; typed codes always win. */
export function normalizeEngineError(error: unknown, operation = 'act'): ApiErrorDetail {
  const message = error instanceof Error ? error.message : String(error);
  const candidate =
    error !== null && typeof error === 'object'
      ? (error as { code?: unknown; retryable?: unknown; details?: unknown })
      : {};
  let code: ErrorCode = ErrorCode.INTERNAL;
  if (typeof candidate.code === 'string' && codes.has(candidate.code)) {
    code = candidate.code as ErrorCode;
  } else if (
    ['RESPONSE_TOO_LARGE', 'MAX_REDIRECTS', 'REDIRECT_LOOP'].includes(String(candidate.code))
  ) {
    code = ErrorCode.POLICY_DENIED;
  } else if (
    /crash|target.*closed|browser.*closed|browser.*disconnect|context.*closed|page.*closed|connection.*closed/i.test(
      message
    )
  ) {
    code = ErrorCode.ENGINE_CRASHED;
  } else if (/QUOTA_EXCEEDED/.test(message)) {
    code = ErrorCode.QUOTA_EXCEEDED;
  } else if (message === 'SESSION_NOT_FOUND') {
    code = ErrorCode.SESSION_NOT_FOUND;
  } else if (/stale|fingerprint/i.test(message)) {
    code = ErrorCode.STALE_TARGET;
  } else if (/multiple elements|ambiguous/i.test(message)) {
    code = ErrorCode.TARGET_AMBIGUOUS;
  } else if (/not found/i.test(message)) {
    code = ErrorCode.TARGET_NOT_FOUND;
  } else if (/timeout|timed out/i.test(message)) {
    code = operation === 'navigate' ? ErrorCode.NAVIGATION_TIMEOUT : ErrorCode.ACTION_TIMEOUT;
  } else if (/no dialog/i.test(message)) {
    code = ErrorCode.INVALID_REQUEST;
  } else if (/not an <input type=['"]?file/i.test(message)) {
    // Playwright's setInputFiles refusal on a non-file element - a caller
    // mistake (wrong ref type), not a server fault.
    code = ErrorCode.INVALID_REQUEST;
  }
  return {
    code,
    message: message === 'SESSION_NOT_FOUND' ? 'Session does not exist.' : message,
    retryable: typeof candidate.retryable === 'boolean' ? candidate.retryable : false,
    ...(candidate.details !== null &&
    typeof candidate.details === 'object' &&
    !Array.isArray(candidate.details)
      ? { details: candidate.details as Record<string, unknown> }
      : {}),
  };
}
