/**
 * Owner-only output files for secrets the CLI writes to disk (cookie exports,
 * private observation captures): exclusive creation, never overwrite, never
 * follow a link, readable by the current user only.
 *
 * POSIX: O_EXCL | O_NOFOLLOW with mode 0600.
 *
 * Windows ignores POSIX modes — a new file simply inherits its directory's
 * ACL, so in a shared directory the "0600" export was readable by others.
 * There, the file is created exclusively ('wx': CREATE_NEW refuses any
 * existing name, link or junction included), its inherited ACEs are removed
 * and only the current user's SID is granted access — all while the file is
 * still empty. The secret is written only after that succeeds; any failure
 * deletes the empty file and fails closed.
 *
 * Residual (documented): another principal with access to the directory who
 * opens the empty file in the instant between creation and the ACL change
 * keeps that handle. Writing into the user's own profile avoids the window.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { type FileHandle, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export type RunCommand = (command: string, args: string[]) => Promise<string>;

/**
 * Which step failed. `create`: nothing was written (the path existed, was a
 * link, or could not be made owner-only). `write`: the private file exists
 * but may be incomplete — callers retain it, since removing it could delete
 * a concurrent replacement at that pathname.
 */
export class PrivateFileError extends Error {
  constructor(
    readonly stage: 'create' | 'write',
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PrivateFileError';
  }
}

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code ?? 'unknown';

export interface PrivateFileOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Runs a system tool and resolves its stdout (injected in tests). */
  run?: RunCommand;
}

const runCommand: RunCommand = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout))
    );
  });

/** The current user's SID from `whoami /user` (CSV: "domain\user","S-1-…"). */
async function currentUserSid(system32: string, run: RunCommand): Promise<string> {
  const out = await run(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const sid = out.match(/"(S-1-[0-9]+(?:-[0-9]+)+)"\s*$/m)?.[1];
  if (!sid) throw new Error('could not determine the current user SID');
  return sid;
}

async function restrictToOwner(path: string, options: Required<PrivateFileOptions>) {
  // Absolute System32 paths: never resolve these tools through PATH.
  const system32 = join(options.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const sid = await currentUserSid(system32, options.run);
  await options.run(join(system32, 'icacls.exe'), [
    path,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:F`,
  ]);
}

/** Create `path` exclusively as an owner-only file and write `text` to it. */
export async function writePrivateFile(
  path: string,
  text: string,
  options: PrivateFileOptions = {}
) {
  const platform = options.platform ?? process.platform;
  const resolved = { platform, env: options.env ?? process.env, run: options.run ?? runCommand };
  let file: FileHandle;
  try {
    file =
      platform === 'win32'
        ? await open(path, 'wx')
        : await open(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600
          );
  } catch (error) {
    throw new PrivateFileError('create', codeOf(error), (error as Error).message);
  }
  if (platform === 'win32') {
    try {
      await restrictToOwner(path, resolved);
    } catch (error) {
      await file.close().catch(() => {});
      // Still empty and ours: remove it rather than leave an unprotected file.
      await unlink(path).catch(() => {});
      throw new PrivateFileError(
        'create',
        'EACL',
        `could not make the file owner-only: ${(error as Error).message}`
      );
    }
  }
  try {
    await file.writeFile(text, 'utf8');
  } catch (error) {
    throw new PrivateFileError('write', codeOf(error), (error as Error).message);
  } finally {
    await file.close().catch(() => {});
  }
  return { path, bytes: Buffer.byteLength(text, 'utf8') };
}
