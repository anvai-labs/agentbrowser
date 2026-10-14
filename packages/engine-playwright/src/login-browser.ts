import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium } from 'playwright';

/**
 * TD-BROWSER-16 phase 4 (ADR-025 §1): the operator's login browser.
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
 *   refused. The Windows CI job runs this suite (headless env), which is
 *   where the win32 branches execute.
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

/**
 * ADR-025 §1: Playwright's Chromium defaults DISABLE these three, which
 * breaks login walls (Safe Browsing, component and background updates).
 * They are REMOVED from the launch via ignoreDefaultArgs — adding them back
 * as args would only duplicate the disable. The committed argv test asserts
 * the live process carries none of them and DOES carry the pipe flag.
 */
const LOGIN_BROWSER_DISABLE_FLAGS = [
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
  /** The exact executable that last wrote the profile (pinned). */
  executable?: string;
  /** Chromium's own version string at pin time, for the record. */
  chromiumVersion?: string;
  /** Monotonic launch counter; a later pin with a SMALLER count for the
   * same executable means the profile was restored from an older backup. */
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
    const headless = this.options.headless ?? false;
    if (!headless && !displayAvailable()) {
      throw new LoginBrowserError(
        'LOGIN_BROWSER_DISPLAY',
        'the login browser needs a display; run headed on a machine with one'
      );
    }
    const executablePath = await this.resolvePinnedExecutable(pin);
    // The lock is acquired LAST: every refusal above must leave the profile
    // unlocked, or a transient mistake (a wider mode, a moved binary, no
    // display) wedges it for the process lifetime.
    await this.acquireProfileLock();
    try {
      this.context = await chromium.launchPersistentContext(this.options.profileDir, {
        headless,
        args: ['--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: [...LOGIN_BROWSER_DISABLE_FLAGS],
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
    const chromiumVersion = this.context.browser()?.version();
    await this.writePin({
      ...(executablePath !== undefined ? { executable: executablePath } : {}),
      ...(chromiumVersion !== undefined ? { chromiumVersion } : {}),
      launches: (pin.launches ?? 0) + 1,
    });
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
      const keyed = (cookie as { partitionKey?: unknown }).partitionKey !== undefined;
      const opaque = (cookie as { partitionKeyOpaque?: unknown }).partitionKeyOpaque !== undefined;
      if (keyed || opaque) {
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
    // First launch pins the binary; later launches must match it exactly.
    if (pin.executable === undefined) return resolved;
    if (pin.executable !== resolved) {
      throw new LoginBrowserError(
        'LOGIN_BINARY_CHANGED',
        'the pinned browser binary changed since this profile was created; reset the profile to adopt the new binary'
      );
    }
    // Same path, different recorded version: the binary was replaced in
    // place (ADR-016 system-Chrome updates land this way). Versions are not
    // ordered — the point is the profile no longer matches the binary.
    if (pin.chromiumVersion !== undefined) {
      const live = await this.liveChromiumVersion(resolved);
      if (live !== undefined && live !== pin.chromiumVersion) {
        throw new LoginBrowserError(
          'LOGIN_BINARY_DOWNGRADED',
          `the browser binary at the pinned path changed version (profile recorded ${pin.chromiumVersion}, now ${live}); reset the profile to adopt it`
        );
      }
    }
    return resolved;
  }

  /** The binary's own version string, via `--version` (never launches). */
  private async liveChromiumVersion(executable: string): Promise<string | undefined> {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { stdout } = await promisify(execFile)(executable, ['--version'], {
        timeout: 10_000,
      });
      const match = /[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/.exec(stdout);
      return match?.[0];
    } catch {
      return undefined; // never block a launch on a version probe
    }
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

// --- Windows DACL (executed by the Windows CI job, which runs this suite) -

/**
 * Profile security on Windows (ADR-025 section 1), via icacls — always
 * present, no PowerShell module system to fail on a runner:
 * - Creation: mkdir, then strip inheritance and grant the owner's SID alone
 *   (OI)(CI)F, so every file Chrome creates inherits owner-only access.
 * - Verification: parse `icacls <dir>` ACE lines by SID; any ACE beyond the
 *   owner (minus SYSTEM and Administrators, which are reported, not refused)
 *   refuses with LOGIN_PROFILE_MODE.
 */
async function createOwnerOnlyDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const sid = await currentUserSid();
  await runIcacls(dir, ['/inheritance:r', '/grant', `*${sid}:(OI)(CI)F`]);
}

async function assertWindowsDaclOwnerOnly(dir: string): Promise<void> {
  const output = await runIcacls(dir, []);
  const me = await currentUserSid();
  const foreign: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    // ACE lines look like `S-1-5-21-...:(OI)(CI)F` or `NT AUTHORITY\SYSTEM:(OI)(CI)F`;
    // summary lines ("Successfully processed 1 files") have no parenthesized rights.
    const ace = /^(.+?):(?:\([^)]*\))+(?:[FRODWS]+)?\s*$/.exec(line);
    if (ace?.[1] === undefined) continue;
    const identity = ace[1].trim();
    if (identity === me) continue;
    if (identity === 'S-1-5-18' || identity === 'S-1-5-32-544') continue;
    foreign.push(identity);
  }
  if (foreign.length > 0) {
    throw new LoginBrowserError(
      'LOGIN_PROFILE_MODE',
      `the login profile directory's ACL grants access beyond its owner: ${foreign.join(', ')}`
    );
  }
}

/** The current user's SID via whoami /user (always present, no modules). */
async function currentUserSid(): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)('whoami', ['/user', '/fo', 'csv'], {
    timeout: 10_000,
  });
  const row = stdout.split(/\r?\n/)[1];
  const sid = row?.split(',').pop()?.replace(/^"|"$/g, '');
  if (sid === undefined || !sid.startsWith('S-1-')) {
    throw new LoginBrowserError('LOGIN_PROFILE_MODE', 'could not determine the current user SID');
  }
  return sid;
}

async function runIcacls(dir: string, args: string[]): Promise<string> {
  const { spawn } = await import('node:child_process');
  const system32 = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'icacls.exe')
    : 'icacls';
  return new Promise((resolve, reject) => {
    const child = spawn(system32, [dir, ...args], { windowsHide: true });
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
      // The full stderr: icacls diagnostics are fixed text and the only
      // variable is the path, which the operator chose.
      else reject(new Error(`icacls failed (${code}): ${err}`));
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
