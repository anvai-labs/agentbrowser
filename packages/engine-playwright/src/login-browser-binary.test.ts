import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ADR-016 binary resolution and ADR-025 §1 pin semantics for the operator
 * login browser — the branded-chrome suite TD-BROWSER-16 deferred.
 *
 * This file mocks `playwright` wholesale, which is why it is separate from
 * login-browser.test.ts (that one launches real Chromium and cannot carry a
 * module-level mock). The payoff is that every branch runs in milliseconds on
 * all three platforms, so the Windows CI job gets the full branded matrix
 * without installing Chrome.
 *
 * Two deliberate choices, both learned the hard way:
 * - Candidate and bundled paths are REAL FILES in a temp dir, not mocked
 *   `fs.access`. ESM namespaces are not spy-able, and more importantly a test
 *   that names /Applications/Google Chrome.app passes or fails depending on
 *   whether the HOST has Chrome installed — the same non-determinism that
 *   makes forcing brandedChromeCandidates necessary in the real-Chromium suite.
 * - The bundled path must exist on disk too, because the pin compares file
 *   identity (size+mtime) and an unreadable binary skips that branch entirely.
 */

/** Set per test to real files under the temp dir; read by the playwright mock. */
let bundledPath = '';

interface Recorded {
  persistent: { profileDir: string; options: Record<string, unknown> }[];
  probe: { options: Record<string, unknown> }[];
}
const recorded: Recorded = { persistent: [], probe: [] };
let probeVersion = '156.0.8078.4';
let contextVersion = '156.0.8078.4';
let probeShouldFail = false;

vi.mock('playwright', () => {
  const makeBrowser = (version: string) => ({
    version: () => version,
    isConnected: () => true,
    close: async () => undefined,
  });
  return {
    chromium: {
      executablePath: () => bundledPath,
      launchPersistentContext: async (profileDir: string, options: Record<string, unknown>) => {
        recorded.persistent.push({ profileDir, options });
        return {
          on: () => undefined,
          cookies: async () => [],
          close: async () => undefined,
          browser: () => makeBrowser(contextVersion),
        };
      },
      launch: async (options: Record<string, unknown>) => {
        recorded.probe.push({ options });
        if (probeShouldFail) throw new Error('probe launch refused');
        return makeBrowser(probeVersion);
      },
    },
  };
});

const { LoginBrowser, looksLikePlaywrightBundled, inspectChromeSingleton } = await import(
  './login-browser.js'
);
const { DEFAULT_LOGIN_LAUNCH_TIMEOUT_MS, parseChromeVersion } = await import('./chrome-binary.js');

let dir: string;
/** A path that looks Playwright-managed AND exists. */
let brandedCandidate: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'login-binary-'));
  // Looks like a Playwright-managed build, so looksLikePlaywrightBundled()
  // treats it as ours — matching the real bundled path's shape.
  bundledPath = join(dir, 'ms-playwright', 'chromium-1248', 'chrome');
  await mkdir(join(dir, 'ms-playwright', 'chromium-1248'), { recursive: true });
  await writeFile(bundledPath, 'bundled-binary');
  brandedCandidate = join(dir, 'chrome-install', 'Google Chrome');
  await mkdir(join(dir, 'chrome-install'), { recursive: true });
  recorded.persistent = [];
  recorded.probe = [];
  probeVersion = '156.0.8078.4';
  contextVersion = '156.0.8078.4';
  probeShouldFail = false;
  delete process.env.AGENTBROWSER_CHROME_PATH;
  delete process.env.AGENTBROWSER_PREFER_BUNDLED;
  delete process.env.AGENTBROWSER_CHROMIUM_ARGS;
  delete process.env.AGENTBROWSER_LOGIN_LAUNCH_TIMEOUT_MS;
  // looksLikePlaywrightBundled no longer consults this, but clearing it keeps
  // the suite's hermeticity enforced rather than incidental: a value that
  // happened to prefix os.tmpdir() used to invert the "neither side
  // Playwright-managed" refusal into an adoption (round-4 review finding 6).
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Make the branded candidate actually exist. */
const installBranded = () => writeFile(brandedCandidate, 'branded-binary');

const profileFor = (name: string) => join(dir, name);
const pinPath = (profile: string) => join(profile, 'agentbrowser-pin.json');
const writePin = async (profile: string, pin: Record<string, unknown>) => {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await writeFile(pinPath(profile), JSON.stringify(pin), { mode: 0o600 });
};
const readPin = async (profile: string) =>
  JSON.parse(await readFile(pinPath(profile), 'utf8')) as Record<string, unknown>;
const mk = (profile: string, options: Record<string, unknown> = {}) =>
  new LoginBrowser({ profileDir: profile, headless: true, ...options });
const lastExecutable = () =>
  recorded.persistent.at(-1)?.options.executablePath as string | undefined;

describe('ADR-016 resolution for the login browser', () => {
  it('launches a detected branded Chrome, and pins it', async () => {
    await installBranded();
    const profile = profileFor('branded');
    const browser = mk(profile, { brandedChromeCandidates: [brandedCandidate] });
    try {
      await browser.open();
      expect(lastExecutable()).toBe(brandedCandidate);
      expect((await readPin(profile)).executable).toBe(brandedCandidate);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('falls back to the bundled build when no candidate exists — passing it EXPLICITLY', async () => {
    const profile = profileFor('bundled');
    // brandedCandidate is NOT created, so detection finds nothing.
    const browser = mk(profile, { brandedChromeCandidates: [brandedCandidate] });
    try {
      await browser.open();
      // Unlike the engine (which omits executablePath for bundled), the login
      // browser always names a concrete file so the pin is meaningful.
      expect(lastExecutable()).toBe(bundledPath);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('preferBundled skips detection even though a candidate exists', async () => {
    await installBranded();
    const profile = profileFor('prefer-bundled');
    const browser = mk(profile, {
      brandedChromeCandidates: [brandedCandidate],
      preferBundled: true,
    });
    try {
      await browser.open();
      expect(lastExecutable()).toBe(bundledPath);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('an explicit chromeBinaryPath wins over a present candidate', async () => {
    await installBranded();
    const explicit = join(dir, 'my-chrome');
    await writeFile(explicit, 'explicit-binary');
    const profile = profileFor('explicit');
    const browser = mk(profile, {
      chromeBinaryPath: explicit,
      brandedChromeCandidates: [brandedCandidate],
    });
    try {
      await browser.open();
      expect(lastExecutable()).toBe(explicit);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('a missing explicit path falls back to bundled — no guessing behind an explicit answer', async () => {
    await installBranded();
    const profile = profileFor('explicit-missing');
    const browser = mk(profile, {
      chromeBinaryPath: join(dir, 'absent-chrome'),
      brandedChromeCandidates: [brandedCandidate],
    });
    try {
      await browser.open();
      // Not the branded candidate, even though it exists: an explicit answer
      // suppresses detection entirely (ADR-016).
      expect(lastExecutable()).toBe(bundledPath);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('AGENTBROWSER_CHROME_PATH is honored, exactly like the session path', async () => {
    const explicit = join(dir, 'env-chrome');
    await writeFile(explicit, 'env-binary');
    process.env.AGENTBROWSER_CHROME_PATH = explicit;
    const profile = profileFor('env-path');
    const browser = mk(profile);
    try {
      await browser.open();
      expect(lastExecutable()).toBe(explicit);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('reuses the headed launch args, including the operator escape hatch', async () => {
    process.env.AGENTBROWSER_CHROMIUM_ARGS = '--unsafely-treat-insecure-origin-as-secure=http://x';
    const profile = profileFor('args');
    const browser = mk(profile, { brandedChromeCandidates: [] });
    try {
      await browser.open();
      const args = recorded.persistent.at(-1)?.options.args as string[];
      expect(args).toContain('--disable-blink-features=AutomationControlled');
      expect(args).toContain('--unsafely-treat-insecure-origin-as-secure=http://x');
      // --start-maximized is a session window-shape choice, not a login one.
      expect(args).not.toContain('--start-maximized');
    } finally {
      await browser.close().catch(() => undefined);
    }
  });
});

describe('ADR-025 §1 pin semantics', () => {
  it('adopts once when the pin named a Playwright build (the pre-fix migration)', async () => {
    await installBranded();
    const profile = profileFor('migrate');
    await writePin(profile, {
      executable: bundledPath,
      executableSize: 52_112,
      executableModifiedMs: 1,
      chromiumVersion: '156.0.8078.4',
      launches: 4,
    });
    const browser = mk(profile, { brandedChromeCandidates: [brandedCandidate] });
    try {
      await browser.open();
      expect(lastExecutable()).toBe(brandedCandidate);
      const pin = await readPin(profile);
      expect(pin.executable).toBe(brandedCandidate);
      expect(pin.adoptedFromExecutable).toBe(bundledPath);
      expect(pin.adoptedFromVersion).toBe('156.0.8078.4');
      // The operator's logins are the asset: the counter continues rather
      // than resetting, and the profile survives.
      expect(pin.launches).toBe(5);
      // Review finding 1: adoption is NOT exempt from the downgrade gate, so
      // it probes the candidate's version exactly like the same-path path.
      expect(recorded.probe).toHaveLength(1);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('REFUSES the bundled→branded migration when the branded Chrome is OLDER', async () => {
    // Review finding 1, the realistic hazard: Playwright often bundles a
    // Chrome for Testing from a FUTURE milestone, so the operator's branded
    // stable Chrome can be older than the build that last wrote the profile.
    // Adopting that unchecked is exactly what ADR-025 §1 forbids ("a profile
    // is never opened by an older binary than the one that last wrote it"),
    // and it would rewrite the pin to the lower version, erasing the evidence.
    await installBranded();
    const profile = profileFor('migrate-downgrade');
    await writePin(profile, {
      executable: bundledPath,
      executableSize: 52_112,
      executableModifiedMs: 1,
      chromiumVersion: '157.0.1.1', // bundled CfT from a newer milestone
      launches: 4,
    });
    probeVersion = '156.0.8078.80'; // the operator's branded stable Chrome
    await expect(
      mk(profile, { brandedChromeCandidates: [brandedCandidate] }).open()
    ).rejects.toMatchObject({ code: 'LOGIN_BINARY_DOWNGRADED' });
    // Never handed the profile to the older binary, and the pin is intact.
    expect(recorded.persistent).toHaveLength(0);
    expect((await readPin(profile)).chromiumVersion).toBe('157.0.1.1');
    expect((await readPin(profile)).executable).toBe(bundledPath);
  });

  it('still adopts the migration when the pin records NO version (old pin format)', async () => {
    // Round-2 review finding 1: fixing the downgrade hole must not brick the
    // migration for a pin written before chromiumVersion was recorded (it is
    // optional, and `browser()?.version()` can yield nothing). That case used
    // to adopt, so failing closed would be strictly worse than the behavior
    // being replaced — it would force the profile-destroying reset() and lose
    // the logins this gate exists to protect.
    await installBranded();
    const profile = profileFor('migrate-no-version');
    await writePin(profile, {
      executable: bundledPath,
      executableSize: 52_112,
      executableModifiedMs: 1,
      launches: 3,
    });
    probeVersion = '156.0.8078.80';
    contextVersion = '156.0.8078.80';
    const browser = mk(profile, { brandedChromeCandidates: [brandedCandidate] });
    try {
      await browser.open();
      expect(lastExecutable()).toBe(brandedCandidate);
      const pin = await readPin(profile);
      expect(pin.launches).toBe(4);
      // The hole closes itself: the next launch HAS a comparable version.
      expect(pin.chromiumVersion).toBe('156.0.8078.80');
      expect(pin.adoptedFromVersion).toBe('(unrecorded)');
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('adopts a bundled-to-bundled path move (a Playwright dependency bump)', async () => {
    const profile = profileFor('rev-bump');
    await writePin(profile, {
      executable: join(dir, 'ms-playwright', 'chromium-1200', 'chrome'),
      executableSize: 1,
      executableModifiedMs: 1,
      chromiumVersion: '150.0.1.1',
      launches: 2,
    });
    const browser = mk(profile, { brandedChromeCandidates: [] });
    try {
      await browser.open();
      expect(lastExecutable()).toBe(bundledPath);
      expect((await readPin(profile)).executable).toBe(bundledPath);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('refuses an unexplained path change — NEITHER side Playwright-managed', async () => {
    // Both the pin and the resolution name operator-installed binaries, so
    // this is the operator pointing at something new, not our resolution
    // changing. That is the only path change that still refuses.
    await installBranded();
    const profile = profileFor('foreign-path');
    await writePin(profile, {
      executable: join(dir, 'some-other-chrome'),
      executableSize: 1,
      executableModifiedMs: 1,
      chromiumVersion: '156.0.8078.4',
      launches: 1,
    });
    await expect(
      mk(profile, { brandedChromeCandidates: [brandedCandidate] }).open()
    ).rejects.toMatchObject({ code: 'LOGIN_BINARY_CHANGED' });
    expect(recorded.persistent).toHaveLength(0);
  });

  it('adopts branded→bundled, the direction the docs prescribe', async () => {
    // Round-3 review finding 2: adoption used to check only the pin, so once
    // it named branded Chrome, AGENTBROWSER_PREFER_BUNDLED=1 — which
    // docs/use-your-login-safely.md and docs/operations.md both recommend for
    // a faster open — refused LOGIN_BINARY_CHANGED and left profile-destroying
    // reset() as the only recovery. Following our own documentation must not
    // cost the operator their logins.
    await installBranded();
    const profile = profileFor('branded-to-bundled');
    await writePin(profile, {
      executable: brandedCandidate,
      executableSize: 1,
      executableModifiedMs: 1,
      chromiumVersion: '156.0.8078.4',
      launches: 7,
    });
    probeVersion = '156.0.8078.90';
    contextVersion = '156.0.8078.90';
    const browser = mk(profile, {
      brandedChromeCandidates: [brandedCandidate],
      preferBundled: true,
    });
    try {
      await browser.open();
      expect(lastExecutable()).toBe(bundledPath);
      const pin = await readPin(profile);
      expect(pin.executable).toBe(bundledPath);
      expect(pin.adoptedFromExecutable).toBe(brandedCandidate);
      expect(pin.launches).toBe(8);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('adopts the bundled fallback when the branded .app vanishes mid-update', async () => {
    // macOS replaces the whole Chrome .app on self-update, so a launch during
    // that window finds no branded binary, falls back to bundled, and must not
    // brick the profile.
    const profile = profileFor('app-swap');
    await writePin(profile, {
      executable: brandedCandidate, // not created: the .app is mid-swap
      executableSize: 1,
      executableModifiedMs: 1,
      chromiumVersion: '156.0.8078.4',
      launches: 2,
    });
    probeVersion = '156.0.8078.90';
    contextVersion = '156.0.8078.90';
    const browser = mk(profile, { brandedChromeCandidates: [brandedCandidate] });
    try {
      await browser.open();
      expect(lastExecutable()).toBe(bundledPath);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('adopts a same-path FORWARD in-place update (a Chrome self-update)', async () => {
    const profile = profileFor('forward');
    await writePin(profile, {
      executable: bundledPath,
      executableSize: 1,
      executableModifiedMs: 1,
      chromiumVersion: '156.0.8078.4',
      launches: 1,
    });
    probeVersion = '156.0.8078.80';
    contextVersion = '156.0.8078.80';
    const browser = mk(profile, { brandedChromeCandidates: [] });
    try {
      await browser.open();
      expect(recorded.persistent).toHaveLength(1);
      expect((await readPin(profile)).chromiumVersion).toBe('156.0.8078.80');
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('refuses a same-path BACKWARDS move and never opens the login profile', async () => {
    const profile = profileFor('backwards');
    await writePin(profile, {
      executable: bundledPath,
      executableSize: 1,
      executableModifiedMs: 1,
      chromiumVersion: '156.0.8078.80',
      launches: 1,
    });
    probeVersion = '155.0.1.1';
    await expect(mk(profile, { brandedChromeCandidates: [] }).open()).rejects.toMatchObject({
      code: 'LOGIN_BINARY_DOWNGRADED',
    });
    // THE load-bearing assertion of this change: the verdict is reached
    // BEFORE the suspect binary is given the login profile. Chrome processes
    // its downgrade handling when it OPENS a profile, so a post-launch verdict
    // would arrive after the logins were already at risk.
    expect(recorded.persistent).toHaveLength(0);
    // And the probe itself never sees the profile directory.
    expect(recorded.probe).toHaveLength(1);
    expect(JSON.stringify(recorded.probe[0]?.options)).not.toContain(profile);
  });

  it('refuses the same version with different bytes (the tamper signature)', async () => {
    const profile = profileFor('same-version');
    await writePin(profile, {
      executable: bundledPath,
      executableSize: 1,
      executableModifiedMs: 1,
      chromiumVersion: '156.0.8078.4',
      launches: 1,
    });
    probeVersion = '156.0.8078.4';
    await expect(mk(profile, { brandedChromeCandidates: [] }).open()).rejects.toMatchObject({
      code: 'LOGIN_BINARY_CHANGED',
    });
    expect(recorded.persistent).toHaveLength(0);
  });

  it('ADOPTS a same-path change when the pin records no version at all', async () => {
    // Deliberately inverted from the original assertion (round-6 finding 1).
    // An absent version cannot evidence a downgrade — nothing was recorded to
    // move backwards from — and refusing on it cost the operator their whole
    // profile for a field WE failed to write. The tamper-shaped case,
    // present-but-unparseable, still fails closed; see the dedicated
    // describe block above.
    const profile = profileFor('no-version');
    await writePin(profile, {
      executable: bundledPath,
      executableSize: 1,
      executableModifiedMs: 1,
      launches: 1,
    });
    probeVersion = '156.0.8078.90';
    contextVersion = '156.0.8078.90';
    const browser = mk(profile, { brandedChromeCandidates: [] });
    try {
      await browser.open();
      expect(recorded.persistent).toHaveLength(1);
      // And the gap closes: the pin now has a comparable version.
      expect(parseChromeVersion((await readPin(profile)).chromiumVersion as string)).toBeDefined();
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('fails CLOSED when the probe cannot answer', async () => {
    const profile = profileFor('probe-dead');
    await writePin(profile, {
      executable: bundledPath,
      executableSize: 1,
      executableModifiedMs: 1,
      chromiumVersion: '156.0.8078.4',
      launches: 1,
    });
    probeShouldFail = true;
    await expect(mk(profile, { brandedChromeCandidates: [] }).open()).rejects.toMatchObject({
      code: 'LOGIN_BINARY_DOWNGRADED',
    });
    expect(recorded.persistent).toHaveLength(0);
  });

  it('gives the persistent launch AND the fail-closed probe the same budget', async () => {
    // The probe used to carry an inline 30s while the real launch carried
    // Playwright's 30s default. Both are launches of the same binary in the
    // same environment, and the probe FAILS CLOSED — a probe that merely ran
    // out of time yields LOGIN_BINARY_DOWNGRADED, which tells the operator to
    // reset() and destroys the logins the gate protects. It also runs on the
    // one-time migration, the launch most likely to be slow under launchd.
    const profile = profileFor('timeout-shared');
    await writePin(profile, {
      executable: bundledPath,
      executableSize: 1,
      executableModifiedMs: 1,
      chromiumVersion: '156.0.8078.4',
      launches: 1,
    });
    probeVersion = '156.0.8078.80';
    contextVersion = '156.0.8078.80';
    const browser = mk(profile, { brandedChromeCandidates: [], loginLaunchTimeoutMs: 77_000 });
    try {
      await browser.open();
      expect(recorded.probe).toHaveLength(1);
      expect(recorded.probe[0]?.options.timeout).toBe(77_000);
      expect(recorded.persistent.at(-1)?.options.timeout).toBe(77_000);
      // And the probe still never sees the login profile.
      expect(JSON.stringify(recorded.probe[0]?.options)).not.toContain(profile);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('passes the default budget when nothing overrides it', async () => {
    const profile = profileFor('timeout-default');
    const browser = mk(profile, { brandedChromeCandidates: [] });
    try {
      await browser.open();
      expect(recorded.persistent.at(-1)?.options.timeout).toBe(DEFAULT_LOGIN_LAUNCH_TIMEOUT_MS);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('does not probe at all on the steady path (pin matches)', async () => {
    const profile = profileFor('steady');
    const browser = mk(profile, { brandedChromeCandidates: [] });
    try {
      await browser.open();
      await browser.close();
      recorded.probe = [];
      await browser.open();
      expect(recorded.probe).toHaveLength(0);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });
});

describe('Chrome ProcessSingleton is read, never removed', () => {
  it('REFUSES a live browser owner, never launches, and leaves the lock on disk', async () => {
    const profile = profileFor('singleton-live');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const lock = join(profile, 'SingletonLock');
    await symlink(`${hostname()}-${process.pid}`, lock);
    // The pid is real and live (it is us); the injected predicate stands in
    // for "and it is a browser", which a test cannot arrange for real. Driven
    // through open() so the class-level refusal is covered, not just the
    // classifier (round-2 review finding 2).
    await expect(
      mk(profile, { brandedChromeCandidates: [], isBrowserPid: async () => true }).open()
    ).rejects.toMatchObject({ code: 'LOGIN_PROFILE_IN_USE' });
    expect(recorded.persistent).toHaveLength(0);
    // Never removed: deleting a live owner's lock would put two Chromes on one
    // cookie DB. Asserted against the filesystem, not the read-only classifier.
    expect(await readlink(lock)).toBe(`${hostname()}-${process.pid}`);
    // And our own profile lock was not taken — every refusal leaves it free.
    expect(existsSync(join(profile, 'agentbrowser-lock'))).toBe(false);
  });

  it('classifies a live non-browser pid as stale (the classifier, directly)', async () => {
    const profile = profileFor('singleton-classify');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await symlink(`${hostname()}-${process.pid}`, join(profile, 'SingletonLock'));
    expect(await inspectChromeSingleton(profile, async () => false)).toMatchObject({
      state: 'stale',
    });
    expect(await inspectChromeSingleton(profile, async () => true)).toMatchObject({
      state: 'live',
      pid: process.pid,
    });
  });

  it('refuses a foreign-host lock', async () => {
    const profile = profileFor('singleton-foreign');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await symlink('some-other-host-4242', join(profile, 'SingletonLock'));
    await expect(mk(profile, { brandedChromeCandidates: [] }).open()).rejects.toMatchObject({
      code: 'LOGIN_PROFILE_IN_USE',
    });
    expect(await inspectChromeSingleton(profile)).toMatchObject({
      state: 'foreign-host',
      host: 'some-other-host',
    });
  });

  it('proceeds past a stale same-host lock — Chrome breaks that one itself', async () => {
    const profile = profileFor('singleton-stale');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    // A pid that cannot be running.
    await symlink(`${hostname()}-2147483646`, join(profile, 'SingletonLock'));
    expect(await inspectChromeSingleton(profile)).toMatchObject({ state: 'stale' });
    const browser = mk(profile, { brandedChromeCandidates: [] });
    try {
      await browser.open();
      expect(recorded.persistent).toHaveLength(1);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('does NOT refuse when the lock pid is live but not a browser (pid recycling)', async () => {
    // Review finding 2: pids recycle, and processExists() also answers true on
    // EPERM for another user's pid. Trusting bare existence would let an
    // unrelated process permanently refuse LOGIN_PROFILE_IN_USE, naming a
    // recovery the operator cannot perform — a regression against the old
    // behavior, where Chrome simply broke the stale lock. Our OWN pid is live
    // and is node, not a browser, so it must classify stale and proceed.
    const profile = profileFor('singleton-recycled');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await symlink(`${hostname()}-${process.pid}`, join(profile, 'SingletonLock'));
    expect(await inspectChromeSingleton(profile)).toMatchObject({ state: 'stale' });
    const browser = mk(profile, { brandedChromeCandidates: [] });
    try {
      await browser.open();
      expect(recorded.persistent).toHaveLength(1);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('classifies absent and unreadable locks as non-blocking', async () => {
    const absent = profileFor('singleton-absent');
    await mkdir(absent, { recursive: true, mode: 0o700 });
    expect(await inspectChromeSingleton(absent)).toEqual({ state: 'absent' });
    const odd = profileFor('singleton-odd');
    await mkdir(odd, { recursive: true, mode: 0o700 });
    await symlink('nonsense', join(odd, 'SingletonLock'));
    expect(await inspectChromeSingleton(odd)).toEqual({ state: 'unreadable' });
  });
});

describe('looksLikePlaywrightBundled', () => {
  it('recognizes Playwright-managed paths and nothing else', () => {
    expect(looksLikePlaywrightBundled(bundledPath)).toBe(true);
    expect(looksLikePlaywrightBundled(join('/var', 'browsers', 'chromium-1248', 'chrome'))).toBe(
      true
    );
    expect(
      looksLikePlaywrightBundled('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ).toBe(false);
    expect(looksLikePlaywrightBundled(join('/usr', 'bin', 'google-chrome'))).toBe(false);
    // Round-5 finding 4: a real Playwright directory name the old pattern
    // missed, because it required digits straight after the separator.
    expect(
      looksLikePlaywrightBundled(
        join('/root', 'chromium_headless_shell-1248', 'chrome-headless-shell')
      )
    ).toBe(true);
    // Round-6 finding 2: a false POSITIVE now adopts a path change that
    // should refuse, so operator-built Chromium trees must NOT match.
    expect(looksLikePlaywrightBundled(join('/opt', 'chromium_build_42', 'chrome'))).toBe(false);
    expect(looksLikePlaywrightBundled(join('/home', 'u', 'chromiumfoo123', 'chrome'))).toBe(false);
    expect(looksLikePlaywrightBundled(join('/opt', 'google', 'chrome', 'chrome'))).toBe(false);
  });

  it('cannot be widened by PLAYWRIGHT_BROWSERS_PATH', () => {
    // Round-4 review finding 3: a bare startsWith on this operator-settable
    // var had no separator boundary, and pointing it at /Applications or /
    // would have made the LOGIN_BINARY_CHANGED branch unreachable entirely.
    try {
      process.env.PLAYWRIGHT_BROWSERS_PATH = '/Applications';
      expect(
        looksLikePlaywrightBundled('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
      ).toBe(false);
      process.env.PLAYWRIGHT_BROWSERS_PATH = '/';
      expect(looksLikePlaywrightBundled(join('/usr', 'bin', 'google-chrome'))).toBe(false);
      process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw';
      expect(looksLikePlaywrightBundled('/opt/pwned/chrome')).toBe(false);
    } finally {
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    }
  });
});

describe('absent vs unparseable pinned version (round-6 finding 1)', () => {
  // The structural rule behind rounds 2, 5 and 6: chromiumVersion is only
  // ever recorded from sources that can fail, so its ABSENCE is our own
  // recording gap and must not cost the operator their profile. A value that
  // is PRESENT but not a version is tamper-shaped and must still fail closed.

  it('a FIRST LAUNCH whose version read fails stays adjudicable afterwards', async () => {
    // Reproduced by the reviewer and needs no legacy pin at all: first launch
    // writes a version-less pin, then an ordinary in-place Chrome update used
    // to hard-refuse with reset() as the only way out.
    contextVersion = '';
    const profile = profileFor('first-launch-no-version');
    const first = mk(profile, { brandedChromeCandidates: [] });
    await first.open();
    await first.close();
    expect((await readPin(profile)).chromiumVersion).toBeUndefined();

    // Now an in-place update of that same binary: different bytes, newer.
    const pin = await readPin(profile);
    await writePin(profile, { ...pin, executableSize: 999_999 });
    probeVersion = '157.0.1.1';
    contextVersion = '157.0.1.1';
    const second = mk(profile, { brandedChromeCandidates: [] });
    try {
      await second.open();
      expect((await readPin(profile)).chromiumVersion).toBe('157.0.1.1');
    } finally {
      await second.close().catch(() => undefined);
    }
  });

  it('a no-version ADOPTION stays adjudicable afterwards', async () => {
    // The other reproduced trigger: the adoption branch deliberately does not
    // probe, so if the context read also fails the pin has no version.
    await installBranded();
    contextVersion = '';
    const profile = profileFor('adopt-no-version');
    await writePin(profile, {
      executable: bundledPath,
      executableSize: 1,
      executableModifiedMs: 1,
      launches: 4,
    });
    const first = mk(profile, { brandedChromeCandidates: [brandedCandidate] });
    await first.open();
    await first.close();

    const pin = await readPin(profile);
    await writePin(profile, { ...pin, executableSize: 999_999 });
    probeVersion = '157.0.1.1';
    contextVersion = '157.0.1.1';
    const second = mk(profile, { brandedChromeCandidates: [brandedCandidate] });
    try {
      await second.open();
      expect((await readPin(profile)).chromiumVersion).toBe('157.0.1.1');
    } finally {
      await second.close().catch(() => undefined);
    }
  });

  it('a PRESENT but unparseable pinned version still fails closed', async () => {
    const profile = profileFor('unparseable-version');
    await writePin(profile, {
      executable: bundledPath,
      executableSize: 1,
      executableModifiedMs: 1,
      chromiumVersion: 'Chrome 140', // the shape captureBrowserVersion exists for
      launches: 1,
    });
    await expect(mk(profile, { brandedChromeCandidates: [] }).open()).rejects.toMatchObject({
      code: 'LOGIN_BINARY_DOWNGRADED',
    });
    expect(recorded.persistent).toHaveLength(0);
  });
});

describe('round-4 regressions', () => {
  it('a version-less pin only escapes the gate when the PIN is the Playwright side', async () => {
    // Round-4 finding 3, second half: widening adoption to either side must
    // not widen the no-version escape. A pin naming BRANDED Chrome with no
    // recorded version resolving to bundled is a real path change we cannot
    // adjudicate, so it must refuse rather than adopt ungated.
    await installBranded();
    const profile = profileFor('no-version-branded-pin');
    await writePin(profile, {
      executable: brandedCandidate,
      executableSize: 1,
      executableModifiedMs: 1,
      launches: 2,
    });
    await expect(
      mk(profile, { brandedChromeCandidates: [brandedCandidate], preferBundled: true }).open()
    ).rejects.toMatchObject({ code: 'LOGIN_BINARY_DOWNGRADED' });
    expect(recorded.persistent).toHaveLength(0);
  });

  it('pins a USABLE version on a path change even when the context reports none', async () => {
    // Round-4 finding 4 said: do not carry the old binary's version onto a new
    // path. Round-5 finding 1 showed the naive fix left the pin with NO
    // comparable version when the context read failed — and the next
    // legitimate in-place update then hard-refused LOGIN_BINARY_DOWNGRADED
    // with profile-destroying reset() as the only recovery. Both must hold:
    // not the stale version, and not nothing either. The probe's reading is
    // the fallback, and `''` counts as absent.
    //
    // Asserting a POSITIVELY usable version on purpose: the earlier version of
    // this test only checked `!== '150.0.1.1'`, which passed because the field
    // was the empty string — it demonstrated the bug instead of guarding it.
    contextVersion = '';
    probeVersion = '156.0.8078.90';
    const profile = profileFor('no-stale-version');
    await writePin(profile, {
      executable: join(dir, 'ms-playwright', 'chromium-1200', 'chrome'),
      executableSize: 1,
      executableModifiedMs: 1,
      chromiumVersion: '150.0.1.1',
      launches: 1,
    });
    const browser = mk(profile, { brandedChromeCandidates: [] });
    try {
      await browser.open();
      const pin = await readPin(profile);
      expect(pin.executable).toBe(bundledPath);
      expect(pin.chromiumVersion).not.toBe('150.0.1.1');
      expect(pin.chromiumVersion).toBe('156.0.8078.90');
      expect(parseChromeVersion(pin.chromiumVersion as string)).toBeDefined();
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

  it('a later in-place update after such an adoption still adjudicates', async () => {
    // The end-to-end consequence of round-5 finding 1: after a path-change
    // adoption, the NEXT legitimate in-place Chrome update must be
    // adjudicable rather than hard-refusing.
    contextVersion = '';
    probeVersion = '156.0.8078.90';
    const profile = profileFor('adjudicable-after-adoption');
    await writePin(profile, {
      executable: join(dir, 'ms-playwright', 'chromium-1200', 'chrome'),
      executableSize: 1,
      executableModifiedMs: 1,
      chromiumVersion: '150.0.1.1',
      launches: 1,
    });
    const first = mk(profile, { brandedChromeCandidates: [] });
    await first.open();
    await first.close();
    // Now simulate an in-place update of the adopted binary: same path,
    // different recorded bytes, a newer version.
    const pin = await readPin(profile);
    await writePin(profile, { ...pin, executableSize: 999_999 });
    probeVersion = '157.0.1.1';
    contextVersion = '157.0.1.1';
    const second = mk(profile, { brandedChromeCandidates: [] });
    try {
      await second.open();
      expect((await readPin(profile)).chromiumVersion).toBe('157.0.1.1');
    } finally {
      await second.close().catch(() => undefined);
    }
  });
});
