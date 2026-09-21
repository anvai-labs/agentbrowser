import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { VERIFIED_UPLOAD_MAX_BYTES, validateUploadIntegrity } from '@agentbrowser/protocol';
import { EngineError } from './errors.js';

/** Detached, bounded bytes: adapters must upload this buffer, never reopen the path. */
export interface VerifiedUpload {
  name: string;
  mimeType: string;
  buffer: Buffer;
  sha256: string;
}

export async function readVerifiedUpload(
  path: string,
  sha256: string,
  mimeType?: string
): Promise<VerifiedUpload> {
  const invalid = validateUploadIntegrity({ type: 'upload', paths: [path], sha256, mimeType });
  if (
    invalid ||
    typeof path !== 'string' ||
    !path.length ||
    !isAbsolute(path) ||
    path.includes('\0') ||
    typeof sha256 !== 'string'
  ) {
    throw new EngineError(
      'INVALID_REQUEST',
      invalid ?? 'Checked upload requires a valid absolute file path and digest'
    );
  }
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.size > VERIFIED_UPLOAD_MAX_BYTES) {
      throw new EngineError(
        'INVALID_REQUEST',
        'Checked upload requires a regular file of at most 16 MiB'
      );
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await file.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      ) {
        throw new EngineError('INVALID_REQUEST', 'Checked upload file changed before reading');
      }
      // One extra byte detects growth without ever reading an unbounded stream.
      const storage = Buffer.alloc(opened.size + 1);
      let total = 0;
      while (total < storage.length) {
        const { bytesRead } = await file.read(storage, total, storage.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      const after = await file.stat();
      if (
        total !== opened.size ||
        !after.isFile() ||
        after.size !== opened.size ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino
      ) {
        throw new EngineError('INVALID_REQUEST', 'Checked upload file changed during reading');
      }
      const buffer = storage.subarray(0, total);
      const actual = createHash('sha256').update(buffer).digest('hex');
      if (actual !== sha256)
        throw new EngineError('INVALID_REQUEST', 'Checked upload SHA-256 digest does not match');
      return {
        name: basename(path),
        mimeType: mimeType ?? 'application/octet-stream',
        buffer,
        sha256: actual,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError('INVALID_REQUEST', 'Checked upload file could not be read safely');
  }
}
