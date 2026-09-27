import { type NavigationFailureReason, isNavigationFailureReason } from '@agentbrowser/protocol';
import { EngineError, normalizeEngineError } from './errors.js';

/** Classify only the operation's own code/prefix, never a URL or later call-log text. */
export function classifyNavigationFailure(
  error: unknown,
  source: 'dns' | 'transport'
): NavigationFailureReason {
  const candidate =
    error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown }) : {};
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  if (source === 'dns') {
    if (code === 'ENOTFOUND' || code === 'ENODATA') return 'dns_unresolved';
    if (code === 'ETIMEOUT' || code === 'ETIMEDOUT') return 'dns_timeout';
    if (code === 'EREFUSED' || code === 'ECONNREFUSED') return 'dns_refused';
    return 'engine_error';
  }
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  const transportCode = /^(?:page\.goto: )?(net::ERR_[A-Z0-9_]+)(?: at |$)/.exec(message)?.[1];
  if (transportCode === 'net::ERR_NAME_NOT_RESOLVED') return 'dns_unresolved';
  if (transportCode === 'net::ERR_CONNECTION_REFUSED' || code === 'ECONNREFUSED')
    return 'connection_refused';
  if (transportCode === 'net::ERR_DNS_TIMED_OUT') return 'dns_timeout';
  if (
    transportCode &&
    /^net::ERR_(?:CERT_(?:AUTHORITY_INVALID|COMMON_NAME_INVALID|DATE_INVALID|REVOKED|INVALID)|SSL_(?:PROTOCOL_ERROR|VERSION_OR_CIPHER_MISMATCH|CLIENT_AUTH_CERT_NEEDED))$/.test(
      transportCode
    )
  )
    return 'tls_refused';
  if (/^(?:route\.fetch: )?getaddrinfo (?:ENOTFOUND|ENODATA)\b/.test(message))
    return 'dns_unresolved';
  if (/^(?:route\.fetch: )?connect ECONNREFUSED\b/.test(message)) return 'connection_refused';
  if (/^(?:route\.fetch: )?getaddrinfo (?:ETIMEOUT|ETIMEDOUT)\b/.test(message))
    return 'dns_timeout';
  if (/^(?:route\.fetch: )?getaddrinfo (?:EREFUSED|ECONNREFUSED)\b/.test(message))
    return 'dns_refused';
  if (
    [
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ].includes(code)
  )
    return 'tls_refused';
  if (
    /^(?:route\.fetch: )?(?:certificate has expired|self-signed certificate|unable to verify the first certificate|Hostname\/IP does not match certificate's altnames)(?:\b|$)/.test(
      message
    )
  )
    return 'tls_refused';
  return 'engine_error';
}

/** Navigation's bounded compatibility seam excludes input URLs/call logs from classification. */
export function normalizeNavigationFailure(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const firstLine = message.split('\n')[0] ?? '';
  // Only driver-owned whole prefixes prove timeout/closure. Connection failure,
  // destination URLs and call logs cannot establish that the browser died.
  const prefix = firstLine.replace(/^page\.goto: /, '');
  const code = /^Timeout [0-9]+ms exceeded\.?$/.test(prefix)
    ? 'NAVIGATION_TIMEOUT'
    : [
          'Target page, context or browser has been closed',
          'Target closed',
          'Browser has been closed',
          'Page crashed',
        ].includes(prefix)
      ? 'ENGINE_CRASHED'
      : 'INTERNAL';
  const failure = normalizeEngineError(
    error instanceof EngineError ? error : new EngineError(code, message),
    'navigate'
  );
  const reason = isNavigationFailureReason(failure.details?.reason)
    ? failure.details.reason
    : classifyNavigationFailure(error, 'transport');
  return {
    code: failure.code,
    message: /^net::ERR_[A-Z0-9_]+$/.test(failure.message)
      ? failure.message
      : reason === 'engine_error' && failure.code === 'INTERNAL'
        ? 'An unexpected engine error occurred'
        : `Navigation failed: ${reason}`,
    retryable: false,
    details: { reason },
  };
}
