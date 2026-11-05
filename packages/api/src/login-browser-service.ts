import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoginBrowser } from '@agentbrowser/engine-playwright';

/**
 * TD-BROWSER-16 phase 4 (ADR-025 §1): the login browser as a service-level
 * singleton — enabled only by AGENTBROWSER_LOGIN_BROWSER=1 with operator keys
 * present. It is not a session: no id, no refs, no pages on any agent
 * surface; only the operator routes touch it.
 */

/**
 * The OS private per-user state root: XDG_STATE_HOME (or its default under
 * ~/.local/state) on POSIX, LOCALAPPDATA on Windows — outside synced and
 * backed-up paths, per the TD.
 */
function defaultLoginProfileRoot(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA ?? process.env.TEMP ?? process.cwd();
  }
  return process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? tmpdir(), '.local', 'state');
}

/**
 * How long shutdown waits for the login browser to close. Short on purpose:
 * close() queues behind any in-flight launch, and shutdown must not inherit
 * the launch budget.
 */
const SHUTDOWN_CLOSE_TIMEOUT_MS = 10_000;

export class LoginBrowserService {
  private browser: LoginBrowser | undefined;
  private readonly enabled: boolean;

  constructor(options: {
    enabled: boolean;
    /** Overrides the profile directory (tests). */
    profileDir?: string;
    /** Test-only: CI drives the lifecycle headless; production is headed. */
    headless?: boolean;
    /**
     * Test-only ADR-016 candidate override. Production leaves this unset so
     * the env fallback (AGENTBROWSER_CHROME_PATH / _PREFER_BUNDLED) and
     * branded detection apply, exactly as for a session. A real-launch test
     * must pass `[]` to pin itself to the bundled build: the ubuntu CI image
     * ships /usr/bin/google-chrome, so without it that job would drive a
     * runner Chrome whose version drifts while the Windows job used bundled.
     */
    brandedChromeCandidates?: string[];
    /**
     * Launch budget override (tests). Production uses the env fallback
     * AGENTBROWSER_LOGIN_LAUNCH_TIMEOUT_MS and its default.
     */
    loginLaunchTimeoutMs?: number;
  }) {
    this.enabled = options.enabled;
    if (options.enabled) {
      this.browser = new LoginBrowser({
        ...(options.headless !== undefined ? { headless: options.headless } : {}),
        ...(options.brandedChromeCandidates !== undefined
          ? { brandedChromeCandidates: options.brandedChromeCandidates }
          : {}),
        ...(options.loginLaunchTimeoutMs !== undefined
          ? { loginLaunchTimeoutMs: options.loginLaunchTimeoutMs }
          : {}),
        // AGENTBROWSER_LOGIN_PROFILE_DIR overrides; the default sits under
        // the OS private per-user state root (never the server's working
        // directory, which can be synced or backed up), with the install
        // root winning when the launcher provides one.
        profileDir:
          options.profileDir ??
          process.env.AGENTBROWSER_LOGIN_PROFILE_DIR ??
          join(process.env.AGENTBROWSER_HOME ?? defaultLoginProfileRoot(), 'login-profile'),
      });
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * TD-BROWSER-16 phase 6 (ADR-025 §3): the handoff floor requires the login
   * browser ENABLED and OPEN — an operator must have signed in for anything
   * to hand over. Disabled reports false (never throws).
   */
  get isOpen(): boolean {
    return this.browser?.isOpen === true;
  }

  async open(): Promise<{ open: true }> {
    this.assertEnabled();
    await this.requireBrowser().open();
    return { open: true };
  }

  async close(): Promise<{ open: false }> {
    this.assertEnabled();
    await this.requireBrowser().close();
    return { open: false };
  }

  async reset(): Promise<{ reset: true }> {
    this.assertEnabled();
    await this.requireBrowser().reset();
    return { reset: true };
  }

  async read(): Promise<Awaited<ReturnType<LoginBrowser['readCookies']>>> {
    this.assertEnabled();
    return this.requireBrowser().readCookies();
  }

  async closeForShutdown(): Promise<void> {
    const browser = this.browser;
    if (browser === undefined) return;
    // Unconditional when a browser exists — NOT guarded on isOpen.
    //
    // isOpen is liveness-based, so guarding on it would SKIP close() for a
    // dead-but-unreaped context and leave agentbrowser-lock on disk: exactly
    // the leak the liveness change exists to prevent (round-1 finding 3).
    // close() tolerates both the never-opened case (it throws
    // LOGIN_BROWSER_CLOSED, swallowed here) and the dead case (it reaps and
    // releases the lock).
    //
    // Bounded, because close() serializes behind an in-flight open() and that
    // launch may now run for the full AGENTBROWSER_LOGIN_LAUNCH_TIMEOUT_MS
    // (round-3 review finding 8). This runs inside Fastify's onClose hook,
    // which has no timeout of its own, so an unbounded await would let a slow
    // launch hold up shutdown for minutes where it used to return at once.
    // Giving up here only forfeits the lock cleanup that the next startup's
    // stale-lock adoption already handles.
    // The timer is CLEARED when close() wins (round-4 review finding 1,
    // reproduced): Promise.race does not cancel the loser, so the warning
    // fired 10s after a perfectly successful close in any process that
    // outlived it — including the api test suite. Having just fixed this
    // component for logging something misleading, it must not start logging
    // the inverse.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        browser.close().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            console.warn(
              `[agentbrowser] login browser did not close within ${SHUTDOWN_CLOSE_TIMEOUT_MS}ms (a launch may still be in flight); continuing shutdown`
            );
            resolve();
          }, SHUTDOWN_CLOSE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private requireBrowser(): LoginBrowser {
    const browser = this.browser;
    if (browser === undefined) throw new Error('the login browser is disabled');
    return browser;
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new Error(
        'the login browser is disabled; set AGENTBROWSER_LOGIN_BROWSER=1 with operator keys configured'
      );
    }
  }
}
