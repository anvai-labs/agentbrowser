#!/usr/bin/env node
/**
 * Compile the MCP server into a single self-contained executable (TD-BROWSER-5).
 *
 * Wraps `bun build --compile` to stamp the binary with the package version —
 * the compiled artifact cannot read package.json at runtime, so the version is
 * injected with --define. Spawned without a shell, so the same invocation works
 * on every CI runner including Windows.
 *
 * Usage:
 *   node scripts/compile.mjs [--target=bun-<platform>-<arch>] [--outfile=<path>]
 * Defaults: host target, dist-bin/agentbrowser-mcp.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const { version } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

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
  '--define',
  `process.env.AGENTBROWSER_MCP_VERSION="${version}"`,
  'src/bin.ts',
  ...(outfileIndex >= 0 ? passthrough : ['--outfile', join(pkgRoot, 'dist-bin', 'agentbrowser-mcp'), ...passthrough]),
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
