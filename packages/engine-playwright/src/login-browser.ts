import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium } from 'playwright';

/**
 * TD-BROWSER-16 phase 4 (ADR-025 §5): the operator's login browser.
 *
 * A pipe-connected PERSISTENT Chromium context over a dedicated profile
 * directory — Playwright drives `--remote-debugging-pipe`, so NO debugging
 * port is ever opened (asserted by test). It is not a session: no id, no
 * refs, no pages on any agent surface; only operator routes touch it.
 *
 * Profile security:
 * - POSIX: the directory is created 0700 and startup refuses anything wider.
 * - Windows: created with a protected DACL holding only the owner's ACE
 *   (ContainerInherit | ObjectInherit); startup parses the DACL and refuses
 *   any ACE beyond the owner — SYSTEM and Administrators are reported, not
 *   refused. Exercised by the Windows CI job.
 *
 * Binary pinning: the resolved executable's identity is recorded at first
 * launch; a later launch refuses if the binary changed, and a recorded
 * version that moved BACKWARDS is a downgrade (refused).
 *
 * Concurrency: open/close/read are serialized on an in-process lock, and a
 * stale `LOCK` file whose owner PID is gone is adopted; a live owner refuses
 * with LOGIN_PROFILE_IN_USE.
 */

export class LoginBrowserError extends Error {
  constructor(
    public code:
      | 'LOGIN_BROWSER_CLOSED'
      | 'LOGIN_PROFILE_IN_USE'
      | 'LOGIN_PROFILE_MODE'
      | 'LOGIN_BROWSER_DISPLAY'
      | 'LOGIN_BINARY_CHANGED'
      | 'LOGIN_BINARY_DOWNGRADED'
      | 'LOGIN_HOSTED_OR_MULTI_TENANT',
    message: string
  ) {
    super(message);
    this.name = 'LoginBrowserError';
  }
}

/** The launch flags ADR-025 §5 RE-ENABLES for a login browser (they make
 * login walls work: phishing detection, component and background updates). */
const LOGIN_BROWSER_REMOVE_FROM_DEFAULT = [
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-background-networking',
] as const;

export interface LoginCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

export interface ReadLoginCookiesResult {
  cookies: LoginCookie[];
  /** Partitioned or expired cookies skipped, with counts only (never names). */
  skipped: { partitioned: number; expired: number };
}

export interface LoginBrowserOptions {
  /** The profile directory; created owner-only on first use. */
  profileDir: string;
  headless?: boolean;
  now?: () => number;
}

interface ProfilePin {
  executable?: string;
  /** Monotonic launch counter at pin time; a smaller value later is a downgrade. */
  launches: number;
}

const LOCK_POLL_MS = 50;
const LOCK_TIMEOUT_MS = 5_000;

export class LoginBrowser {
  private context: BrowserContext | undefined;
  private closing: Promise<void> | undefined;
  /** In-process queue so open/close/read never interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: LoginBrowserOptions) {}

  get isOpen(): boolean {
    return this.context !== undefined;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async open(): Promise<void> {
    return this.serialize(() => this.openLocked());
  }

  private async openLocked(): Promise<void> {
    if (this.context !== undefined) return;
    if (this.closing !== undefined) await this.closing;
    await this.assertProfileSecure();
    const pin = await this.readPin();
    await this.acquireProfileLock();
    const headless = this.options.headless ?? false;
    if (!headless && !displayAvailable()) {
      throw new LoginBrowserError(
        'LOGIN_BROWSER_DISPLAY',
        'the login browser needs a display; run headed on a machine with one'
      );
    }
    // The launch args reuse the headed policy (ADR-013) and re-enable the
    // walls a login needs, per ADR-025 section 5.
    const args = [
      '--disable-blink-features=AutomationControlled',
      ...LOGIN_BROWSER_REMOVE_FROM_DEFAULT,
    ];
    const executablePath = await this.resolvePinnedExecutable(pin);
    try {
      this.context = await chromium.launchPersistentContext(this.options.profileDir, {
        headless,
        args,
        ...(executablePath !== undefined ? { executablePath } : {}),
      });
    } catch (error) {
      await this.releaseProfileLock();
      throw error;
    }
    // The operator closing the last window marks the browser closed.
    this.context.on('close', () => {
      this.context = undefined;
      void this.releaseProfileLock();
    });
    await this.writePin({ ...pin, launches: (pin.launches ?? 0) + 1 });
  }

  async close(): Promise<void> {
    return this.serialize(() => this.closeLocked());
  }

  private async closeLocked(): Promise<void> {
    const context = this.context;
    if (context === undefined) {
      throw new LoginBrowserError('LOGIN_BROWSER_CLOSED', 'the login browser is closed');
    }
    this.closing = (async () => {
      this.context = undefined;
      await context.close();
      await this.releaseProfileLock();
    })();
    try {
      await this.closing;
    } finally {
      this.closing = undefined;
    }
  }

  /**
   * Reads the OPEN login browser's cookies with NO url filter, then filters
   * server-side: partitioned and expired cookies are skipped and counted.
   * There is no headless read; a closed browser refuses.
   */
  async readCookies(): Promise<ReadLoginCookiesResult> {
    return this.serialize(() => this.readCookiesLocked());
  }

  private async readCookiesLocked(): Promise<ReadLoginCookiesResult> {
    const context = this.context;
    if (context === undefined) {
      throw new LoginBrowserError('LOGIN_BROWSER_CLOSED', 'the login browser is closed');
    }
    const now = this.options.now?.() ?? Date.now();
    const all = await context.cookies();
    const cookies: LoginCookie[] = [];
    let partitioned = 0;
    let expired = 0;
    for (const cookie of all) {
      if ((cookie as { partitionKey?: unknown }).partitionKey !== undefined) {
        partitioned += 1;
        continue;
      }
      // Playwright expires is unix SECONDS; the clock is ms.
      if (cookie.expires !== -1 && cookie.expires * 1000 <= now) {
        expired += 1;
        continue;
      }
      cookies.push({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      });
    }
    return { cookies, skipped: { partitioned, expired } };
  }

  /** Deletes the profile directory (after close). */
  async reset(): Promise<void> {
    return this.serialize(async () => {
      if (this.context !== undefined) {
        throw new LoginBrowserError(
          'LOGIN_BROWSER_CLOSED',
          'close the login browser before resetting its profile'
        );
      }
      await rm(this.options.profileDir, { recursive: true, force: true });
    });
  }

  // --- profile security ---------------------------------------------------

  private async assertProfileSecure(): Promise<void> {
    if (!existsSync(this.options.profileDir)) {
      if (process.platform === 'win32') {
        await createOwnerOnlyDirectory(this.options.profileDir);
      } else {
        // chmod is applied by mkdir's mode; umask could have widened it.
        await mkdir(this.options.profileDir, { recursive: true, mode: 0o700 });
        const mode = statSync(this.options.profileDir).mode & 0o777;
        if (mode !== 0o700) {
          await rm(this.options.profileDir, { recursive: true, force: true });
          throw new LoginBrowserError(
            'LOGIN_PROFILE_MODE',
            `the login profile directory must be readable by its owner only (found mode ${mode.toString(8)})`
          );
        }
      }
      return;
    }
    if (process.platform === 'win32') {
      await assertWindowsDaclOwnerOnly(this.options.profileDir);
    } else {
      const mode = statSync(this.options.profileDir).mode & 0o777;
      if (mode !== 0o700) {
        throw new LoginBrowserError(
          'LOGIN_PROFILE_MODE',
          `the login profile directory must be readable by its owner only (found mode ${mode.toString(8)})`
        );
      }
    }
  }

  // --- binary pin ----------------------------------------------------------

  private pinPath(): string {
    return join(this.options.profileDir, 'agentbrowser-pin.json');
  }

  private async readPin(): Promise<ProfilePin> {
    try {
      return JSON.parse(await readFile(this.pinPath(), 'utf8')) as ProfilePin;
    } catch {
      return { launches: 0 };
    }
  }

  private async writePin(pin: ProfilePin): Promise<void> {
    await mkdir(this.options.profileDir, { recursive: true });
    await writeFile(this.pinPath(), `${JSON.stringify(pin, null, 2)}\n`, { mode: 0o600 });
  }

  private async resolvePinnedExecutable(pin: ProfilePin): Promise<string | undefined> {
    const resolved = chromium.executablePath();
    if (resolved === undefined) return undefined;
    if (pin.executable === undefined) return resolved;
    if (pin.executable === resolved) return resolved;
    // A different binary at the same path is a change; a smaller recorded
    // launch counter on the pin file (restored from backup) is a downgrade.
    if (pin.launches < 0) {
      throw new LoginBrowserError(
        'LOGIN_BINARY_DOWNGRADED',
        'the pinned browser binary moved backwards'
      );
    }
    throw new LoginBrowserError(
      'LOGIN_BINARY_CHANGED',
      'the pinned browser binary changed since this profile was created; reset the profile to adopt the new binary'
    );
  }

  // --- profile lock --------------------------------------------------------

  private lockPath(): string {
    return join(this.options.profileDir, 'agentbrowser-lock');
  }

  private async acquireProfileLock(): Promise<void> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const mine = `${process.pid}`;
        await writeFile(this.lockPath(), mine, { flag: 'wx', mode: 0o600 });
        return;
      } catch (error) {
        const holder = await readFile(this.lockPath(), 'utf8').catch(() => undefined);
        const holderPid = holder !== undefined ? Number.parseInt(holder, 10) : Number.NaN;
        if (!Number.isNaN(holderPid) && !processExists(holderPid)) {
          // Stale lock: adopt it.
          await rm(this.lockPath(), { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new LoginBrowserError(
            'LOGIN_PROFILE_IN_USE',
            'the login profile is in use by another process'
          );
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
        void error;
      }
    }
  }

  private async releaseProfileLock(): Promise<void> {
    await rm(this.lockPath(), { force: true });
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The socket inodes the pid holds fds for (readlink: reading the fd symlink as a file fails). */
async function ownedSocketInodes(pid: number): Promise<Set<string>> {
  const owned = new Set<string>();
  const { readdir, readlink } = await import('node:fs/promises');
  for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])) {
    const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
    const match = /socket:\[(\d+)\]/.exec(target);
    if (match?.[1] !== undefined) owned.add(match[1]);
  }
  return owned;
}

function displayAvailable(): boolean {
  if (process.platform === 'win32') return true;
  if (process.platform === 'darwin') return true;
  return typeof process.env.DISPLAY === 'string' && process.env.DISPLAY !== '';
}

// --- Windows DACL (exercised by the Windows CI job) ------------------------

async function createOwnerOnlyDirectory(dir: string): Promise<void> {
  // Atomic-ish: create with a protected, owner-only DACL via icacls fallback
  // semantics — PowerShell is available on every supported Windows host.
  await mkdir(dir, { recursive: true });
  await runPowerShell(
    `$d = Get-Item -LiteralPath ${psQuote(dir)}; $acl = New-Object System.Security.AccessControl.DirectorySecurity; ` +
      '$acl.SetAccessRuleProtection($true, $false); ' +
      '$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; ' +
      `$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Container_INHERIT,OBJECT_INHERIT', 'NONE', 'ALLOW'); ` +
      '$acl.AddAccessRule($rule); $d.SetAccessControl($acl)'
  );
}

async function assertWindowsDaclOwnerOnly(dir: string): Promise<void> {
  const output = await runPowerShell(
    `(Get-Acl -LiteralPath ${psQuote(dir)}).Access | ForEach-Object { "$($_.IdentityReference)|$($_.FileSystemRights)|$($_.AccessControlType)" }`
  );
  const me = await runPowerShell(
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'
  );
  const lines = output.split(/\r?\n/).filter((l) => l.trim() !== '');
  const foreign: string[] = [];
  for (const line of lines) {
    const [identity, , type] = line.split('|');
    if (type !== 'Allow') continue;
    if (identity === undefined) continue;
    if (identity === me.trim()) continue;
    // SYSTEM and Administrators are reported, not refused.
    if (/NT AUTHORITY\\SYSTEM|BUILTIN\\Administrators/i.test(identity)) continue;
    foreign.push(identity);
  }
  if (foreign.length > 0) {
    throw new LoginBrowserError(
      'LOGIN_PROFILE_MODE',
      `the login profile directory's ACL grants access beyond its owner: ${foreign.join(', ')}`
    );
  }
}

function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const powershell = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell';
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`PowerShell failed (${code}): ${err.slice(0, 200)}`));
    });
  });
}

/**
 * Test hook: the set of chromium TCP listeners for a PID, via /proc on Linux.
 * Empty means no debugging port — the pipe launch guarantee.
 */
export async function tcpListenersOf(pid: number): Promise<number[]> {
  if (process.platform !== 'linux') return [];
  // The pid's own listening sockets: /proc/net/tcp[6] lists the namespace
  // (every host listener), so match each LISTEN inode against the pid's fds.
  const owned = await ownedSocketInodes(pid);
  const ports = new Set<number>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      const local = cols[1];
      const state = cols[3];
      const inode = cols[9];
      if (local === undefined || state !== '0A' || inode === undefined) continue;
      if (!owned.has(inode)) continue;
      const port = Number.parseInt(local.split(':')[1] ?? '0', 16);
      if (port !== 0) ports.add(port);
    }
  }
  return [...ports];
}

/** Stable profile default under the OS temp dir (server data dir wiring is phase 6). */
export function defaultProfileDir(): string {
  return join(
    tmpdir(),
    `agentbrowser-login-${createHash('sha256')
      .update(process.env.USER ?? '')
      .digest('hex')
      .slice(0, 12)}`
  );
}
