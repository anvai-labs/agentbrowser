/**
 * Tests for version resolution (TD-BROWSER-5).
 *
 * The compiled binary is stamped at build time and cannot read package.json,
 * so every resolution path matters: stamp, runtime override, package file,
 * and the explicit unknown fallback.
 */

import { describe, expect, it } from 'vitest';
import { readPackageVersion, resolveVersion } from './version';

describe('resolveVersion', () => {
  it('prefers an explicit override', () => {
    expect(resolveVersion({ AGENTBROWSER_MCP_VERSION: '9.9.9-test' })).toBe('9.9.9-test');
  });

  it('falls back to the package version, which must be semver', () => {
    // Runs from src/ where package.json is readable one level up.
    expect(resolveVersion({})).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('readPackageVersion', () => {
  it('reads the version next to the real module', () => {
    expect(readPackageVersion(import.meta.url)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('returns undefined when no package.json is reachable (compiled binary)', () => {
    expect(readPackageVersion('file:///nowhere/at/all/version.ts')).toBeUndefined();
  });
});
