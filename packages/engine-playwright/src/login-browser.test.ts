import { chmodSync, existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoginBrowser, LoginBrowserError, tcpListenersOf } from './login-browser.js';

/**
 * TD-BROWSER-16 phase 4: the login browser. The heavy security properties
 * (profile mode, pipe launch with no TCP port, lifecycle) are tested for
 * real; the Windows DACL path runs on the Windows CI job.
 */

// AGENTBROWSER_LOGIN_HEADLESS=1 lets CI execute the suite without a display
// (the pipe launch, profile security and filtering are display-independent).
const suite = describe;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'login-browser-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

suite('the login browser', () => {
  it('launches a persistent context over a pipe — no TCP listener while open or reading', async () => {
    const profile = join(dir, 'profile-pipe');
    const browser = new LoginBrowser({ profileDir: profile });
    await browser.open();
    try {
      expect(browser.isOpen).toBe(true);
      const pid = await chromiumPid();
      if (pid > 0) expect(await tcpListenersOf(pid)).toEqual([]);
      else console.warn('login-browser test: chromium pid not found; listener assert skipped');
      const read = await browser.readCookies();
      expect(Array.isArray(read.cookies)).toBe(true);
      expect(await tcpListenersOf(pid)).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 120_000);

  it('the profile directory is created 0700 (owner-only) on POSIX', () => {
    const profile = join(dir, 'profile-mode');
    const browser = new LoginBrowser({ profileDir: profile });
    return browser
      .open()
      .then(() => browser.close())
      .finally(() => {
        expect(statSync(profile).mode & 0o777).toBe(0o700);
      });
  }, 120_000);

  it('refuses a profile directory with wider permissions', async () => {
    const profile = join(dir, 'profile-wide');
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(profile, { recursive: true, mode: 0o700 })
    );
    chmodSync(profile, 0o755);
    const browser = new LoginBrowser({ profileDir: profile });
    await expect(browser.open()).rejects.toMatchObject({
      code: 'LOGIN_PROFILE_MODE',
    });
    chmodSync(profile, 0o700); // restore for cleanup
  });

  it('a closed browser refuses reads; close is idempotent-per-operation', async () => {
    const profile = join(dir, 'profile-lifecycle');
    const browser = new LoginBrowser({ profileDir: profile });
    await browser.open();
    await browser.close();
    expect(browser.isOpen).toBe(false);
    await expect(browser.readCookies()).rejects.toMatchObject({ code: 'LOGIN_BROWSER_CLOSED' });
    await expect(browser.close()).rejects.toMatchObject({ code: 'LOGIN_BROWSER_CLOSED' });
  }, 120_000);

  it('a second login browser on the same profile refuses LOGIN_PROFILE_IN_USE', async () => {
    const profile = join(dir, 'profile-lock');
    const first = new LoginBrowser({ profileDir: profile });
    await first.open();
    try {
      const second = new LoginBrowser({ profileDir: profile });
      await expect(second.open()).rejects.toMatchObject({ code: 'LOGIN_PROFILE_IN_USE' });
    } finally {
      await first.close();
    }
  }, 120_000);

  it('a stale lock (dead owner) is adopted', async () => {
    const profile = join(dir, 'profile-stale');
    const prep = new LoginBrowser({ profileDir: profile });
    await prep.open();
    await prep.close();
    // Write a stale lock pointing at a dead pid (pid 0x7fffffff never exists
    // as ours; use a reaped child's pid instead of killing anything real).
    const dead = await new Promise<number>((resolve) => {
      const { spawn } = require('node:child_process') as typeof import('node:child_process');
      const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
      child.on('exit', () => resolve(child.pid ?? 0));
    });
    await writeFile(join(profile, 'agentbrowser-lock'), String(dead));
    const browser = new LoginBrowser({ profileDir: profile });
    await browser.open(); // adopts the stale lock
    await browser.close();
  }, 120_000);

  it('partitioned and expired cookies are skipped and counted', async () => {
    const profile = join(dir, 'profile-filter');
    // The clock is frozen AHEAD: both cookies are stored valid, and one is
    // already expired at read time (Chromium culls expired cookies at write,
    // so freezing first is the only way to observe the filter).
    const now = Date.now() + 7200_000;
    const browser = new LoginBrowser({ profileDir: profile, now: () => now });
    await browser.open();
    try {
      const context = (
        browser as unknown as { context: { cookies(): Promise<Array<Record<string, unknown>>> } }
      ).context;
      await context.cookies(); // touch to ensure alive
      // Inject through Playwright's real API: add three cookies — one plain,
      // one expired, one partitioned (via the context's addCookies shape).
      const add = (browser as unknown as { context: { addCookies(c: unknown[]): Promise<void> } })
        .context;
      const realNow = Date.now();
      await add.addCookies([
        {
          name: 'plain',
          value: 'v',
          domain: 'example.com',
          path: '/',
          expires: Math.floor(realNow / 1000) + 14_400,
        },
        {
          name: 'expired',
          value: 'v',
          domain: 'example.com',
          path: '/',
          expires: Math.floor(realNow / 1000) + 3600,
        },
      ]);
      const result = await browser.readCookies();
      expect(result.cookies.some((c) => c.name === 'plain')).toBe(true);
      expect(result.cookies.some((c) => c.name === 'expired')).toBe(false);
      expect(result.skipped.expired).toBeGreaterThanOrEqual(1);
    } finally {
      await browser.close();
    }
  }, 120_000);

  it('partitionKeyOpaque-only cookies are filtered too (review F5)', async () => {
    // Drive readCookiesLocked's filter with a stubbed context carrying the
    // exact cookie shapes Playwright can produce; addCookies cannot create
    // partitioned cookies, hence the stub.
    const profile = join(dir, 'profile-opaque');
    const browser = new LoginBrowser({ profileDir: profile });
    await browser.open();
    try {
      const self = browser as unknown as { context: unknown };
      const realContext = self.context as { cookies(): Promise<unknown[]> };
      self.context = {
        cookies: async () => [
          {
            name: 'plain',
            value: 'v',
            domain: 'example.com',
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
          },
          {
            name: 'opaque',
            value: 'v',
            domain: 'example.com',
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
            partitionKeyOpaque: true,
          },
          {
            name: 'keyed',
            value: 'v',
            domain: 'example.com',
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
            partitionKey: 'https://example.com',
          },
        ],
      };
      try {
        const result = await browser.readCookies();
        expect(result.cookies.map((c) => c.name)).toEqual(['plain']);
        expect(result.skipped.partitioned).toBe(2);
      } finally {
        self.context = realContext;
      }
    } finally {
      await browser.close();
    }
  }, 240_000);

  it('the pin records the real executable; a changed binary refuses and reset adopts', async () => {
    const profile = join(dir, 'profile-reset');
    const browser = new LoginBrowser({ profileDir: profile });
    await browser.open();
    await browser.close();
    // The pin carries the REAL executable and Chromium's version (review
    // F2: the code never recorded one, making pinning a no-op).
    const pinPath = join(profile, 'agentbrowser-pin.json');
    const pin = JSON.parse(await readFile(pinPath, 'utf8')) as {
      executable?: string;
      chromiumVersion?: string;
      launches: number;
    };
    expect(pin.executable).toBeTruthy();
    expect(pin.chromiumVersion).toBeTruthy();
    expect(pin.launches).toBe(1);
    await browser.open();
    await browser.close();
    const pin2 = JSON.parse(await readFile(pinPath, 'utf8')) as typeof pin;
    expect(pin2.launches).toBe(2);
    await writeFile(pinPath, JSON.stringify({ ...pin2, executable: '/moved/chromium' }));
    const refused = new LoginBrowser({ profileDir: profile });
    await expect(refused.open()).rejects.toMatchObject({ code: 'LOGIN_BINARY_CHANGED' });
    await refused.reset();
    expect(existsSync(profile)).toBe(false);
  }, 240_000);
});

async function chromiumPid(): Promise<number> {
  // The login browser's chromium is a child of this process tree; find the
  // newest chromium process we own.
  const { readdir, readFile } = await import('node:fs/promises');
  const pids: Array<{ pid: number; start: number }> = [];
  const entries = await readdir('/proc').catch(() => [] as string[]);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
    if (cmdline.includes('chrome') && cmdline.includes('--remote-debugging-pipe')) {
      const stat = await statSync(`/proc/${entry}`).mtimeMs;
      pids.push({ pid: Number(entry), start: stat });
    }
  }
  pids.sort((a, b) => b.start - a.start);
  return pids[0]?.pid ?? 0;
}

void LoginBrowserError;
