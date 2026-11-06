import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compareChromeVersion,
  DEFAULT_LOGIN_LAUNCH_TIMEOUT_MS,
  defaultBrandedChromeCandidates,
  extraChromiumArgs,
  loginLaunchTimeout,
  parseChromeVersion,
  preferBundledEnv,
  resolveBrandedChrome,
  resolveChromeBinaryPreference,
  SLOW_LOGIN_LAUNCH_MS,
} from './chrome-binary.js';

/**
 * The ADR-016 resolution extracted from PlaywrightChromiumEngine so the
 * operator login browser can share it (ADR-025 §1). The engine's own
 * behavior is pinned end-to-end by launch-diagnostics.test.ts; this covers
 * the seam directly, plus the version arithmetic the login-browser pin uses.
 */

let dir: string;
let present: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chrome-binary-'));
  present = join(dir, 'chrome');
  await writeFile(present, 'binary');
  delete process.env.AGENTBROWSER_CHROME_PATH;
  delete process.env.AGENTBROWSER_PREFER_BUNDLED;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('resolveBrandedChrome (ADR-016 precedence)', () => {
  it('an existing explicit path wins, reported as explicit', async () => {
    await expect(
      resolveBrandedChrome({
        chromeBinaryPath: present,
        preferBundled: false,
        brandedChromeCandidates: [present],
      })
    ).resolves.toEqual({ path: present, selection: 'explicit' });
  });

  it('a missing explicit path yields the default — no detection behind an explicit answer', async () => {
    await expect(
      resolveBrandedChrome({
        chromeBinaryPath: join(dir, 'absent'),
        preferBundled: false,
        brandedChromeCandidates: [present],
      })
    ).resolves.toEqual({ selection: 'playwright_default' });
  });

  it('preferBundled skips detection even when a candidate exists', async () => {
    await expect(
      resolveBrandedChrome({ preferBundled: true, brandedChromeCandidates: [present] })
    ).resolves.toEqual({ selection: 'playwright_default' });
  });

  it('detection takes the FIRST existing candidate', async () => {
    const second = join(dir, 'chrome-2');
    await writeFile(second, 'binary');
    await expect(
      resolveBrandedChrome({
        preferBundled: false,
        brandedChromeCandidates: [join(dir, 'absent'), present, second],
      })
    ).resolves.toEqual({ path: present, selection: 'detected' });
  });

  it('no candidates at all yields the default', async () => {
    await expect(
      resolveBrandedChrome({ preferBundled: false, brandedChromeCandidates: [] })
    ).resolves.toEqual({ selection: 'playwright_default' });
  });
});

describe('env defaults match the engine constructor', () => {
  it('reads AGENTBROWSER_CHROME_PATH and AGENTBROWSER_PREFER_BUNDLED', () => {
    process.env.AGENTBROWSER_CHROME_PATH = present;
    process.env.AGENTBROWSER_PREFER_BUNDLED = '1';
    const resolved = resolveChromeBinaryPreference();
    expect(resolved.chromeBinaryPath).toBe(present);
    expect(resolved.preferBundled).toBe(true);
    expect(resolved.brandedChromeCandidates).toEqual(defaultBrandedChromeCandidates());
  });

  it('explicit options beat the environment', () => {
    process.env.AGENTBROWSER_CHROME_PATH = present;
    process.env.AGENTBROWSER_PREFER_BUNDLED = 'true';
    const resolved = resolveChromeBinaryPreference({
      chromeBinaryPath: '/opt/injected',
      preferBundled: false,
      brandedChromeCandidates: [],
    });
    expect(resolved).toEqual({
      chromeBinaryPath: '/opt/injected',
      preferBundled: false,
      brandedChromeCandidates: [],
    });
  });

  it('preferBundledEnv accepts only 1 and true', () => {
    for (const [value, expected] of [
      ['1', true],
      ['true', true],
      ['yes', false],
      ['0', false],
      ['', false],
    ] as const) {
      process.env.AGENTBROWSER_PREFER_BUNDLED = value;
      expect(preferBundledEnv()).toBe(expected);
    }
  });

  it('platform candidates name branded Chrome, never a Playwright build', () => {
    for (const candidate of defaultBrandedChromeCandidates()) {
      expect(candidate.toLowerCase()).toContain('chrome');
      expect(candidate).not.toContain('ms-playwright');
    }
  });
});

describe('Chrome version arithmetic (the pin’s "moved backwards" rule)', () => {
  it('compares component-wise, not lexically and not as a float', () => {
    const a = parseChromeVersion('156.0.8078.80');
    const b = parseChromeVersion('156.0.9.100');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Lexical order would say "156.0.9.100" is larger; parseFloat would read
    // both as 156.0. Build-wise, 8078 > 9.
    expect(compareChromeVersion(a as number[], b as number[])).toBe(1);
  });

  it('treats missing trailing components as zero', () => {
    const short = parseChromeVersion('156');
    const long = parseChromeVersion('156.0.0.0');
    expect(compareChromeVersion(short as number[], long as number[])).toBe(0);
  });

  it('orders a genuine update forward and a downgrade backward', () => {
    const pinned = parseChromeVersion('156.0.8078.4') as number[];
    expect(compareChromeVersion(parseChromeVersion('156.0.8078.80') as number[], pinned)).toBe(1);
    expect(compareChromeVersion(parseChromeVersion('155.0.1.1') as number[], pinned)).toBe(-1);
    expect(compareChromeVersion(parseChromeVersion('156.0.8078.4') as number[], pinned)).toBe(0);
  });

  it('refuses to parse anything that is not a plain dotted number', () => {
    // captureBrowserVersion exists because values like "Chrome 140" occur;
    // everything unparseable must read as "not comparable" so callers refuse.
    for (const raw of [
      undefined,
      '',
      '   ',
      'Chrome 140',
      '156.0.8078.80-beta',
      'v156.0',
      '156..0',
      '1.2.3.4.5',
      '99999999',
    ]) {
      expect(parseChromeVersion(raw)).toBeUndefined();
    }
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseChromeVersion(' 156.0.8078.80 ')).toEqual([156, 0, 8078, 80]);
  });
});

describe('loginLaunchTimeout', () => {
  afterEach(() => {
    delete process.env.AGENTBROWSER_LOGIN_LAUNCH_TIMEOUT_MS;
  });

  it('defaults generously, because Playwright’s 30s is too tight here', () => {
    expect(loginLaunchTimeout()).toBe(DEFAULT_LOGIN_LAUNCH_TIMEOUT_MS);
    // The measured launchd+branded open was 23s, so the default must leave
    // real headroom above it rather than the 7s Playwright's default did.
    expect(DEFAULT_LOGIN_LAUNCH_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it('reads the env var', () => {
    process.env.AGENTBROWSER_LOGIN_LAUNCH_TIMEOUT_MS = '45000';
    expect(loginLaunchTimeout()).toBe(45_000);
  });

  it('an invalid env value WARNS and falls back — never takes the server down', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const raw of ['0', '12', 'soon', '-5000', '99999999', '1e4', '5000.5', ' ']) {
        process.env.AGENTBROWSER_LOGIN_LAUNCH_TIMEOUT_MS = raw;
        expect(loginLaunchTimeout()).toBe(DEFAULT_LOGIN_LAUNCH_TIMEOUT_MS);
      }
      // ' ' trims to empty, which is "unset", so it warns for the other 7.
      expect(warn).toHaveBeenCalledTimes(7);
    } finally {
      warn.mockRestore();
    }
  });

  it('an invalid EXPLICIT value throws — a caller passing nonsense is a bug', () => {
    for (const value of [0, 12, -1, 600_001, 1.5, Number.NaN]) {
      expect(() => loginLaunchTimeout(value)).toThrow(RangeError);
    }
    expect(loginLaunchTimeout(5_000)).toBe(5_000);
    expect(loginLaunchTimeout(600_000)).toBe(600_000);
  });

  it('an explicit value beats the environment', () => {
    process.env.AGENTBROWSER_LOGIN_LAUNCH_TIMEOUT_MS = '45000';
    expect(loginLaunchTimeout(90_000)).toBe(90_000);
  });

  it('the slow-launch threshold sits between shell and launchd reality', () => {
    // ~1-3.6s from a shell must stay quiet; ~23s under launchd must warn.
    expect(SLOW_LOGIN_LAUNCH_MS).toBeGreaterThan(3_600);
    expect(SLOW_LOGIN_LAUNCH_MS).toBeLessThan(23_000);
  });
});

describe('extraChromiumArgs', () => {
  it('splits on whitespace and drops blanks', () => {
    expect(extraChromiumArgs('  --a   --b  ')).toEqual(['--a', '--b']);
    expect(extraChromiumArgs('')).toEqual([]);
    expect(extraChromiumArgs(undefined)).toEqual([]);
  });
});
