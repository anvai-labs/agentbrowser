/** Shared opt-in upload integrity contract; no filesystem or browser dependencies. */
export const VERIFIED_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
export const UPLOAD_SHA256_PATTERN = '^[a-f0-9]{64}$';
export const UPLOAD_MIME_TYPE_PATTERN = '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$';
export const UPLOAD_MIME_TYPE_MAX_LENGTH = 127;

const digest = new RegExp(UPLOAD_SHA256_PATTERN);
const mime = new RegExp(UPLOAD_MIME_TYPE_PATTERN);

/** Cross-field rules reused by wire, core and direct engine callers. */
export function validateUploadIntegrity(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const action = input as Record<string, unknown>;
  if (action.sha256 === undefined && action.mimeType === undefined) return undefined;
  if ((action.type ?? action.action) !== 'upload') {
    return 'sha256 and mimeType are only supported for upload';
  }
  if (typeof action.sha256 !== 'string' || !digest.test(action.sha256)) {
    return 'Checked upload requires a lowercase 64-character SHA-256 digest';
  }
  if (!Array.isArray(action.paths) || action.paths.length !== 1) {
    return 'Checked upload requires exactly one file path';
  }
  if (
    action.mimeType !== undefined &&
    (typeof action.mimeType !== 'string' ||
      action.mimeType.length > UPLOAD_MIME_TYPE_MAX_LENGTH ||
      !mime.test(action.mimeType))
  ) {
    return 'Checked upload MIME metadata must be a type/subtype of at most 127 characters';
  }
  return undefined;
}
