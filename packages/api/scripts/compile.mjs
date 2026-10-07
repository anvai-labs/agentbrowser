#!/usr/bin/env node
/**
 * Compile the REST API server into a single self-contained executable.
 *
 * Same pipeline as packages/mcp-server/scripts/compile.mjs (TD-BROWSER-5):
 * `bun build --compile` over the server entrypoint, spawned without a shell
 * so the identical invocation works on every CI runner including Windows.
 *
 * Unlike the MCP binary there is no --define version stamp: the server has
 * no AGENTBROWSER_*_VERSION env read, and its /health plane does not report
 * package.json version (the compiled artifact cannot read package.json, so
 * if a version surface is added to the server later, add the stamp then).
 *
 * Usage:
 *   node scripts/compile.mjs [--target=bun-<platform>-<arch>] [--outfile=<path>]
 * Defaults: host target, dist-bin/agentbrowser-server.
 */

import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const passthrough = process.argv.slice(2);

// An explicit --outfile is honored in the CALLER's frame (relative to where
// the script is invoked); only the default is package-root-relative. Bun
// runs with cwd=pkgRoot below, so rewrite the caller's path to absolute.
const outfileIndex = passthrough.findIndex(
  (arg) => arg === '--outfile' || arg.startsWith('--outfile=')
);
const spaceForm = outfileIndex >= 0 && passthrough[outfileIndex] === '--outfile';
if (spaceForm && passthrough[outfileIndex + 1]) {
  passthrough[outfileIndex + 1] = resolve(passthrough[outfileIndex + 1]);
} else if (!spaceForm && outfileIndex >= 0) {
  passthrough[outfileIndex] =
    `--outfile=${resolve(passthrough[outfileIndex].slice('--outfile='.length))}`;
}

const args = [
  'build',
  '--compile',
  // playwright-core lazily requires chromium-bidi (its BiDi transport) and
  // electron (launching an Electron app) but declares neither as a
  // dependency, so pnpm never links them beside it. Node never executes
  // those requires on the CDP path this server uses; Bun's compile-time
  // bundler, however, resolves every require statically and hard-fails on
  // Windows (observed on the first v1.15.2 tag run; darwin resolves the
  // bare specifier through the pnpm store, which is why host validation
  // missed it). Externalizing keeps the requires lazy — never taken —
  // instead of unresolvable at build time.
  '--external',
  'chromium-bidi',
  '--external',
  'electron',
  'src/bin.ts',
  ...(outfileIndex >= 0
    ? passthrough
    : ['--outfile', join(pkgRoot, 'dist-bin', 'agentbrowser-server'), ...passthrough]),
];

const result = spawnSync('bun', args, { stdio: 'inherit', cwd: pkgRoot });

if (result.error) {
  console.error(
    'Failed to launch bun. Install it first: https://bun.sh\n' +
      '  brew install bun        (macOS / Linux)\n' +
      '  powershell -c "irm bun.sh/install.ps1 | iex"   (Windows)'
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
