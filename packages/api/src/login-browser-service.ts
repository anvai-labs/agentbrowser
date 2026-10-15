import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoginBrowser } from '@agentbrowser/engine-playwright';

/**
 * TD-BROWSER-16 phase 4 (ADR-025 §1): the login browser as a service-level
 * singleton — enabled only by AGENTBROWSER_LOGIN_BROWSER=1 with operator keys
 * present. It is not a session: no id, no refs, no pages on any agent
 * surface; only the operator routes touch it.
 */

export const LOGIN_BROWSER_ROUTES = Object.freeze([
  'login.open',
  'login.close',
  'login.reset',
  'login.read',
] as const);

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

export class LoginBrowserService {
  private browser: LoginBrowser | undefined;
  private readonly enabled: boolean;

  constructor(options: {
    enabled: boolean;
    /** Overrides the profile directory (tests). */
    profileDir?: string;
    /** Test-only: CI drives the lifecycle headless; production is headed. */
    headless?: boolean;
  }) {
    this.enabled = options.enabled;
    if (options.enabled) {
      this.browser = new LoginBrowser({
        ...(options.headless !== undefined ? { headless: options.headless } : {}),
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
    if (this.browser?.isOpen === true) await this.browser.close().catch(() => undefined);
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
