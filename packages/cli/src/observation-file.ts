/**
 * Private observation capture: write the full observation JSON to a new
 * 0600 file (the cookie-export discipline — exclusive creation, no symlink
 * follow, never overwrite) and hand back a compact receipt so the bulk of
 * the bytes lands on disk instead of in the caller's context.
 */
import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { UsageError } from '@agentbrowser/sdk-typescript';

export async function writeObservationFile(path: string, observation: unknown) {
  // Minified: the file is machine-facing (jq, diff, archival evidence).
  const text = `${JSON.stringify(observation)}\n`;
  let file: FileHandle;
  try {
    file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new UsageError(
      `Could not exclusively create observation output file (${code}: path exists, parent missing, is a symlink, or is not writable).`
    );
  }
  try {
    await file.writeFile(text, 'utf8');
    await file.close();
  } catch {
    await file.close().catch(() => {});
    // Retain incomplete private output: this pathname may now identify
    // another file; removing it could delete a concurrent replacement.
    throw new UsageError('Could not write observation output file.');
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
