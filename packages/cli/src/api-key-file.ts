import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { UsageError } from '@agentbrowser/sdk-typescript';

/** Credentials are independent of resource IDs. Never return file/driver errors. */
export function readApiKeyFile(path: string): string {
  // POSIX mode checks do not validate Windows ACLs. Refuse this optional input
  // channel there until a descriptor-bound DACL reader is available.
  if (process.platform === 'win32')
    throw new UsageError(
      'API key files require POSIX owner checks; on Windows use AGENTBROWSER_API_KEY.'
    );
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    ) {
      throw new Error();
    }
    const buffer = Buffer.alloc(4097);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    const key = buffer
      .subarray(0, size)
      .toString('utf8')
      .replace(/\r?\n$/, '');
    if (size > 4096 || !key || /[^\x21-\x7e]/.test(key)) throw new Error();
    return key;
  } catch {
    throw new UsageError(
      'Cannot read API key file: use an owner-only regular file (0600), at most 4096 bytes, containing one credential.'
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
