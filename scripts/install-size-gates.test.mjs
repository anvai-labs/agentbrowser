#!/usr/bin/env node
/** T8 install-size gate: the packaged server candidate must stay within
 * explicit compressed and extracted size bounds (T8 packet: "Compare
 * isolated imports/install sizes"). Run from the repo root after the
 * packaging step produced the candidate:
 *
 *   node --test scripts/install-size-gates.test.mjs --out-dir out-packages
 *
 * Limits carry headroom over the worst observed across platforms
 * (darwin-arm64 2026-10-01: 9.2 MB compressed, 55.7 MB extracted;
 * linux-x64 2026-10-02 CI: 7.7 MB compressed, 37.5 MB extracted) —
 * 1.30x / 1.44x worst, so the first tightening pass (2026-10-02, once
 * Linux numbers existed) held these at 12/80 MB and tightened the RSS
 * gates instead. Tighten with a recorded reason, loosen only with a
 * measured regression named in the commit.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/** Explicit named limits (bytes). */
const LIMITS = { compressed: 12 * 1024 * 1024, extracted: 80 * 1024 * 1024 };

const outDir = process.env.PACKAGE_OUT_DIR ?? 'out-packages';
const target = process.env.PACKAGE_TARGET ?? `${process.platform}-${process.arch}`;
const tarball = join(outDir, `agentbrowser-server-${target}.tar.gz`);

test('the packaged candidate exists', () => {
  assert.ok(existsSync(tarball), `candidate missing: ${tarball} (run package-server.mjs first)`);
});

test('compressed candidate stays within the size gate', () => {
  const bytes = statSync(tarball).size;
  console.log(`footprint: candidate compressed ${Math.round(bytes / 1024)} KB (gate ${LIMITS.compressed} bytes)`);
  assert.ok(
    bytes <= LIMITS.compressed,
    `compressed candidate ${bytes} bytes exceeds the ${LIMITS.compressed}-byte gate`
  );
});

test('extracted candidate stays within the size gate and ships the server entrypoints', () => {
  const extract = mkdtempSync(join(tmpdir(), 'install-size-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', extract], { stdio: 'pipe' });
    const serverRoot = join(extract, 'server');
    for (const required of [
      join(serverRoot, 'agentbrowser-server'),
      join(serverRoot, 'VERSION.json'),
      join(serverRoot, 'node_modules', '@agentbrowser', 'control', 'dist', 'journal-sqlite-child.js'),
    ]) {
      assert.ok(existsSync(required), `packaged candidate is missing ${required}`);
    }
    // Cross-platform recursive size walk (du -sk differs in block accounting
    // between macOS and Linux; byte-sum is comparable across both).
    let totalBytes = 0;
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) walk(child);
        else totalBytes += statSync(child).size;
      }
    };
    walk(serverRoot);
    console.log(`footprint: extracted server tree ${Math.round(totalBytes / 1024)} KB (gate ${LIMITS.extracted} bytes)`);
    assert.ok(
      totalBytes <= LIMITS.extracted,
      `extracted server tree ${totalBytes} bytes exceeds the ${LIMITS.extracted}-byte gate`
    );
  } finally {
    rmSync(extract, { recursive: true, force: true });
  }
});
