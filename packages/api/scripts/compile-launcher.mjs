#!/usr/bin/env node
/**
 * Compile the Windows bundle's server launcher (src/launcher/main.ts) into a
 * single executable.
 *
 * Only the launcher is compiled: it imports node: builtins alone (enforced by
 * src/launcher/core.test.ts), so Bun has nothing to bake a build-machine path
 * into. The server itself ships as an intact Node tree beside it — Playwright
 * is bundler-hostile (v1.17.0's single-file server exe failed off CI for
 * exactly that reason).
 *
 * Usage:
 *   node scripts/compile-launcher.mjs [--target=bun-<platform>-<arch>] [--outfile=<path>]
 * Defaults: host target, dist-bin/agentbrowser-server.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const passthrough = process.argv.slice(2);

// An explicit --outfile is honored in the CALLER's frame; only the default is
// package-root-relative. Bun runs with cwd=pkgRoot, so make it absolute.
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
  'src/launcher/main.ts',
  ...(outfileIndex >= 0
    ? passthrough
    : ['--outfile', join(pkgRoot, 'dist-bin', 'agentbrowser-server'), ...passthrough]),
];

const result = spawnSync(process.env.BUN ?? 'bun', args, { stdio: 'inherit', cwd: pkgRoot });

if (result.error) {
  console.error(
    'Failed to launch bun. Install it first: https://bun.sh\n' +
      '  brew install bun        (macOS / Linux)\n' +
      '  powershell -c "irm bun.sh/install.ps1 | iex"   (Windows)'
  );
  process.exit(1);
}

process.exit(result.status ?? 1);
