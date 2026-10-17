/**
 * Owner-only output files for secrets the CLI writes to disk (cookie exports,
 * private observation captures): exclusive creation, never overwrite, never
 * follow a link, readable by the current user only.
 *
 * POSIX: O_EXCL | O_NOFOLLOW with mode 0600 — atomic.
 *
 * Windows ignores POSIX modes: a file created by Node inherits its
 * directory's ACL, and setting an ACL afterwards (icacls) leaves a window in
 * which another principal can open the empty file and keep the handle, or —
 * with delete rights in the directory — swap it for a decoy so the lockdown
 * lands on the decoy while the secret goes to the original. So the file is
 * created atomically WITH its security descriptor instead: a fixed Windows
 * PowerShell script calls .NET's FileStream(CreateNew, FileShare.None,
 * FileSecurity), whose DACL is protected (no inheritance) and holds exactly
 * one ACE: the current user, FullControl. There is no moment at which the
 * file exists with any other ACL.
 *
 * The script is a constant; the path travels in an environment variable and
 * the secret over stdin — never in argv, never interpolated into code.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Which step failed. `create`: nothing was written (the path existed, its
 * parent is missing, it was a link, or access was denied). `write`: the
 * private file exists but may be incomplete — callers retain it, since
 * removing it could delete a concurrent replacement at that pathname.
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

export interface PrivateFileResult {
  path: string;
  bytes: number;
}

/** One invocation of the Windows writer (injected in tests). */
export type RunWindowsWriter = (request: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  input: Buffer;
}) => Promise<{ code: number | null; stderr: string }>;

export interface PrivateFileOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runWindowsWriter?: RunWindowsWriter;
}

/** Path handed to the Windows writer (never part of the script text). */
export const PRIVATE_PATH_ENV = 'AGENTBROWSER_PRIVATE_PATH';

/**
 * Creates $env:AGENTBROWSER_PRIVATE_PATH exclusively with a protected,
 * single-ACE (current user, FullControl) DACL, then copies stdin into it.
 * Exit 3 + "create:<code>" or exit 4 + "write:<code>" on failure.
 */
export const WINDOWS_WRITER_SCRIPT = `$ErrorActionPreference = 'Stop'
$path = $env:${PRIVATE_PATH_ENV}
try {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $sec = New-Object System.Security.AccessControl.FileSecurity
  $sec.SetAccessRuleProtection($true, $false)
  $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
  $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $sec)
} catch {
  $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
  $code = if ($e -is [System.IO.DirectoryNotFoundException]) { 'ENOENT' } elseif (($e.HResult -band 0xffff) -eq 80) { 'EEXIST' } elseif ($e -is [System.UnauthorizedAccessException]) { 'EACCES' } else { 'EUNKNOWN' }
  [Console]::Error.WriteLine("create:$code"); exit 3
}
try {
  $in = [Console]::OpenStandardInput(); $in.CopyTo($fs); $fs.Flush($true)
} catch { [Console]::Error.WriteLine('write:EIO'); exit 4 } finally { $fs.Dispose() }
`;

const runWindowsWriter: RunWindowsWriter = ({ command, args, env, input }) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });

async function writeWindows(path: string, text: string | Uint8Array, options: PrivateFileOptions) {
  const env = options.env ?? process.env;
  // Absolute System32 path: never resolve PowerShell through PATH.
  const powershell = join(
    env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  let result: { code: number | null; stderr: string };
  try {
    result = await (options.runWindowsWriter ?? runWindowsWriter)({
      command: powershell,
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_WRITER_SCRIPT,
      ],
      env: { ...env, [PRIVATE_PATH_ENV]: resolve(path) },
      input: typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(text),
    });
  } catch (error) {
    throw new PrivateFileError(
      'create',
      'ESPAWN',
      `could not run the private-file writer: ${(error as Error).message}`
    );
  }
  if (result.code === 0) return;
  const reported = result.stderr.match(/^(create|write):([A-Z]+)/m);
  const stage = reported?.[1] === 'write' ? 'write' : 'create';
  throw new PrivateFileError(
    stage,
    reported?.[2] ?? 'EUNKNOWN',
    `private-file writer exited ${result.code}`
  );
}

async function writePosix(path: string, text: string | Uint8Array) {
  let file: FileHandle;
  try {
    file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
  } catch (error) {
    throw new PrivateFileError(
      'create',
      (error as NodeJS.ErrnoException).code ?? 'EUNKNOWN',
      (error as Error).message
    );
  }
  try {
    await file.writeFile(text, 'utf8');
    // close() can surface deferred write errors (network, quota): a failed
    // close is a failed write, never a reported success.
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    throw new PrivateFileError(
      'write',
      (error as NodeJS.ErrnoException).code ?? 'EIO',
      (error as Error).message
    );
  }
}

/** Create `path` exclusively as an owner-only file holding `text`. */
export async function writePrivateFile(
  path: string,
  text: string | Uint8Array,
  options: PrivateFileOptions = {}
): Promise<PrivateFileResult> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') await writeWindows(path, text, options);
  else await writePosix(path, text);
  return { path, bytes: Buffer.byteLength(text, 'utf8') };
}
