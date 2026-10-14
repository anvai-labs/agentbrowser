import { join } from 'node:path';
import { LoginBrowser } from '@agentbrowser/engine-playwright';

/**
 * TD-BROWSER-16 phase 4 (ADR-025 §5): the login browser as a service-level
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

export class LoginBrowserService {
  private browser: LoginBrowser | undefined;
  private readonly enabled: boolean;

  constructor(options: {
    enabled: boolean;
    /** Overrides the profile directory (tests). */
    profileDir?: string;
  }) {
    this.enabled = options.enabled;
    if (options.enabled) {
      this.browser = new LoginBrowser({
        // AGENTBROWSER_LOGIN_PROFILE_DIR overrides; the default sits under
        // the OS private temp root, outside synced and backed-up paths.
        profileDir:
          options.profileDir ??
          process.env.AGENTBROWSER_LOGIN_PROFILE_DIR ??
          join(process.env.AGENTBROWSER_HOME ?? process.cwd(), 'login-profile'),
      });
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
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

  async read(): Promise<ReturnType<LoginBrowser['readCookies']>> {
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
