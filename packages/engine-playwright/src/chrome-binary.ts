/**
 * ADR-016 headed-binary resolution, shared by the two surfaces that launch a
 * headed Chromium: sessions (`PlaywrightChromiumEngine.headedChromiumOptions`)
 * and the operator login browser (`LoginBrowser`).
 *
 * Why it lives here and not in index.ts: `index.ts` re-exports `LoginBrowser`
 * from `./login-browser.js`, so a login-browser import of `index.ts` would be a
 * runtime import cycle (biome `suspicious/noImportCycles`, error). A leaf module
 * both import is the available seam. It imports nothing local, on purpose.
 *
 * ADR-025 §1 says the login browser "reuses headedChromiumOptions" and resolves
 * via "ADR-016's branded-Chrome selection, or AGENTBROWSER_CHROME_PATH". Before
 * this module it did neither — it called `chromium.executablePath()` and always
 * got Playwright's bundled Chrome for Testing, which is what this shares out.
 */

export type ExecutableSelection = 'explicit' | 'detected' | 'playwright_default';

/** The three ADR-016 knobs, injectable so tests can pin resolution. */
export interface ChromeBinaryPreference {
  chromeBinaryPath?: string;
  preferBundled?: boolean;
  brandedChromeCandidates?: string[];
}

/** The same preference with env defaults applied — what the resolver consumes. */
export interface ResolvedChromeBinaryPreference {
  chromeBinaryPath?: string;
  preferBundled: boolean;
  brandedChromeCandidates: string[];
}

/**
 * Apply the env defaults exactly as the engine constructor does, so the login
 * browser and a session cannot drift on what AGENTBROWSER_CHROME_PATH or
 * AGENTBROWSER_PREFER_BUNDLED mean.
 */
export function resolveChromeBinaryPreference(
  options: ChromeBinaryPreference = {}
): ResolvedChromeBinaryPreference {
  const chromeBinaryPath = options.chromeBinaryPath ?? process.env.AGENTBROWSER_CHROME_PATH;
  return {
    ...(chromeBinaryPath !== undefined ? { chromeBinaryPath } : {}),
    preferBundled: options.preferBundled ?? preferBundledEnv(),
    brandedChromeCandidates: options.brandedChromeCandidates ?? defaultBrandedChromeCandidates(),
  };
}

export function defaultBrandedChromeCandidates(): string[] {
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    return [
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
}

export function preferBundledEnv(): boolean {
  const value = process.env.AGENTBROWSER_PREFER_BUNDLED;
  return value === '1' || value === 'true';
}

/**
 * Parse AGENTBROWSER_CHROMIUM_ARGS into Chromium launch flags.
 *
 * Operator escape hatch for engine-level Chromium policies the page stack
 * cannot override. Motivating case (2026-09-25 field run): Chrome's Local
 * Network Access enforcement kills same-origin XHR from pages ON a private
 * IP — a LAN-hosted console's fetch to its own origin throws without
 * reaching the server — defeating the CIDR allowlist for exactly the flows
 * the operator opted into.
 *
 * Space-separated; unset or blank yields no flags. Scope: HEADED CHROMIUM
 * launches only. The headless pool keeps stock launch defaults on purpose
 * (ADR-013: headless detection is honest and desired), firefox/webkit
 * launches never receive Chromium flags, and both CDP attach paths
 * (cdpEndpoint, operatorCdp) cannot apply launch flags at all — the
 * constructor warns on those two when the variable is set.
 */
export function extraChromiumArgs(raw: string | undefined): string[] {
  return (raw ?? '').trim().split(/\s+/).filter(Boolean);
}

/**
 * ADR-016 binary precedence: explicit path (probed; missing → bundled, no
 * detection behind an explicit answer) > first existing branded candidate >
 * bundled Chromium, with preferBundled skipping detection entirely.
 *
 * Behavioral details the existing engine tests pin — do not "clean up":
 * - `node:fs/promises` is imported DYNAMICALLY, inside the function. Two
 *   suites install a hoisted `vi.mock` with a pass-through `access`, and the
 *   dynamic form preserves the evaluation timing they rely on.
 * - `access(candidate)` is called with exactly ONE argument;
 *   launch-diagnostics asserts `toHaveBeenCalledWith(path)` and an exact
 *   `mock.calls` array, so a stray `fs.constants.F_OK` breaks it.
 * - An explicit path that fails probes NO candidates, and preferBundled
 *   probes nothing at all (zero `access` calls). Candidate probing stops at
 *   the first hit.
 */
export async function resolveBrandedChrome(
  preference: ResolvedChromeBinaryPreference
): Promise<{ path?: string; selection: ExecutableSelection }> {
  const fs = await import('node:fs/promises');
  if (preference.chromeBinaryPath !== undefined) {
    try {
      await fs.access(preference.chromeBinaryPath);
      return { path: preference.chromeBinaryPath, selection: 'explicit' };
    } catch {
      return { selection: 'playwright_default' };
    }
  }
  if (preference.preferBundled) return { selection: 'playwright_default' };
  for (const candidate of preference.brandedChromeCandidates) {
    try {
      await fs.access(candidate);
      return { path: candidate, selection: 'detected' };
    } catch {
      // candidate absent — keep probing
    }
  }
  return { selection: 'playwright_default' };
}

/**
 * Chrome's own version, as `MAJOR.MINOR.BUILD.PATCH`, parsed for comparison.
 *
 * Strict on purpose: `captureBrowserVersion`
 * (packages/protocol/src/session-diagnostics.ts) exists because values like
 * "Chrome 140" do occur, so anything that is not a wholly numeric dotted
 * string of 1..4 components yields undefined — and every caller treats
 * undefined as "not comparable", i.e. refuse. Never parseFloat (it would read
 * 156.0.8078.80 as 156.0) and never localeCompare ("156.0.9.100" must sort
 * BELOW "156.0.8078.80" component-wise, which string order gets wrong).
 */
export function parseChromeVersion(raw: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d{1,7}(\.\d{1,7}){0,3}$/.test(trimmed)) return undefined;
  return trimmed.split('.').map((part) => Number.parseInt(part, 10));
}

/** Component-wise numeric compare; missing trailing components count as 0. */
export function compareChromeVersion(a: number[], b: number[]): -1 | 0 | 1 {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}
