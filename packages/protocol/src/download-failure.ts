import { type ApiErrorDetail, ErrorCode } from './errors.js';
import { isScopeDenialCode } from './navigation-failure.js';
import { CONTROL_OPERATION_ID } from './operation-id.js';

const codes = new Set<string>(Object.values(ErrorCode));

/**
 * Transfer stages a download transport reports. The protocol owns this list
 * (ADR-015: one source of truth); `download-transport` consumes it so the
 * stages the server emits can never drift from the stages this projection
 * keeps.
 */
export const DOWNLOAD_TRANSFER_STAGES = Object.freeze([
  'admission',
  'connect',
  'tls',
  'headers',
  'response',
  'redirect',
  'body',
] as const);
export type DownloadTransferStage = (typeof DOWNLOAD_TRANSFER_STAGES)[number];
const stages = new Set<string>(DOWNLOAD_TRANSFER_STAGES);

/** The bounded reason a transport-stage failure carries; owned here for the same reason. */
export const DOWNLOAD_TRANSFER_FAILURE_REASON = 'transferFailed' as const;

/** Download client errors never echo URLs, filenames, adapter prose or arbitrary details. */
export function downloadFailureDetail(error: unknown): ApiErrorDetail {
  const candidate =
    error && typeof error === 'object'
      ? (error as { code?: unknown; details?: unknown })
      : undefined;
  const code = candidate?.code;
  const rawDetails = candidate?.details;
  const source =
    rawDetails && typeof rawDetails === 'object'
      ? (rawDetails as Record<string, unknown>)
      : undefined;
  const scope = source?.scope;
  const stage = source?.stage;
  const reason = source?.reason;
  const operationId = source?.operationId;
  const details = {
    ...(isScopeDenialCode(scope) ? { scope } : {}),
    ...(typeof stage === 'string' && stages.has(stage) ? { stage } : {}),
    ...(reason === DOWNLOAD_TRANSFER_FAILURE_REASON ? { reason } : {}),
    ...(typeof operationId === 'string' && CONTROL_OPERATION_ID.test(operationId)
      ? { operationId }
      : {}),
  };
  return {
    code: typeof code === 'string' && codes.has(code) ? (code as ErrorCode) : ErrorCode.INTERNAL,
    message: `Download failed${isScopeDenialCode(scope) ? ` (${scope})` : ''}`,
    retryable: false,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}
