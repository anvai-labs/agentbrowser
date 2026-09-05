#!/usr/bin/env node
/**
 * Compile the CLI into a single self-contained executable.
 *
 * Same shape as packages/mcp-server/scripts/compile.mjs (TD-BROWSER-5
 * pipeline): `bun build --compile` over the CLI entrypoint. The CLI's only
 * dependencies are commander and the fetch-only SDK, both bundle-clean.
 *
 * Usage:
 *   node scripts/compile.mjs [--target=bun-<platform>-<arch>] [--outfile=<path>]
 * Defaults: host target, dist-bin/agentbrowser.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const passthrough = process.argv.slice(2);

// An explicit --outfile is honored in the CALLER's frame (relative to where
// the script was invoked); only the default is package-root-relative. Bun
// runs with cwd=pkgRoot below, so rewrite the caller's path to absolute.
const outfileIndex = passthrough.findIndex((arg) => arg === '--outfile' || arg.startsWith('--outfile='));
const spaceForm = outfileIndex >= 0 && passthrough[outfileIndex] === '--outfile';
if (spaceForm && passthrough[outfileIndex + 1]) {
  passthrough[outfileIndex + 1] = resolve(passthrough[outfileIndex + 1]);
} else if (!spaceForm && outfileIndex >= 0) {
  passthrough[outfileIndex] = `--outfile=${resolve(passthrough[outfileIndex].slice('--outfile='.length))}`;
}

const args = [
  'build',
  '--compile',
  'src/bin.ts',
  ...(outfileIndex >= 0 ? passthrough : ['--outfile', join(pkgRoot, 'dist-bin', 'agentbrowser'), ...passthrough]),
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
