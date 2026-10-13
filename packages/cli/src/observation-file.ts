/**
 * Private observation capture: write the full observation JSON to a new
 * owner-only file (private-file.ts: exclusive creation, no symlink follow,
 * never overwrite; an owner-only ACL on Windows) and hand back a compact receipt so the bulk of
 * the bytes lands on disk instead of in the caller's context.
 */
import { UsageError } from '@agentbrowser/sdk-typescript';
import { PrivateFileError, writePrivateFile } from './private-file.js';

export async function writeObservationFile(path: string, observation: unknown) {
  // Minified: the file is machine-facing (jq, diff, archival evidence).
  const text = `${JSON.stringify(observation)}\n`;
  try {
    await writePrivateFile(path, text);
  } catch (error) {
    if (error instanceof PrivateFileError && error.stage === 'write') {
      // Retain incomplete private output: this pathname may now identify
      // another file; removing it could delete a concurrent replacement.
      throw new UsageError('Could not write observation output file.');
    }
    const code = error instanceof PrivateFileError ? error.code : 'unknown';
    throw new UsageError(
      `Could not exclusively create observation output file (${code}: path exists, parent missing, is a symlink, is not writable, or could not be made owner-only).`
    );
  }
  return { path, bytes: Buffer.byteLength(text, 'utf8') };
}

/** Receipt for stdout when the observation went to a file: identity + counts. */
export function observationReceipt(
  observation: {
    sessionId: string;
    pageId: string;
    revision: number;
    url: string;
    elements: unknown[];
    truncated: boolean;
    projection?: { matched: number; total: number };
  },
  file: { path: string; bytes: number }
) {
  return {
    sessionId: observation.sessionId,
    pageId: observation.pageId,
    revision: observation.revision,
    url: observation.url,
    elements: observation.elements.length,
    truncated: observation.truncated,
    ...(observation.projection !== undefined ? { projection: observation.projection } : {}),
    file: { path: file.path, bytes: file.bytes },
  };
}
