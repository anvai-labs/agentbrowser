/**
 * Version resolution for the MCP server (TD-BROWSER-5).
 *
 * The version reported in `initialize` has exactly one source of truth:
 * packages/mcp-server/package.json. Three paths cover every runtime:
 *
 * 1. Compiled binary: scripts/compile.mjs stamps the version at build time
 *    via `bun build --define`, replacing the `process.env.AGENTBROWSER_MCP_VERSION`
 *    expression below with a string literal. The package.json file itself is
 *    bundled away, so this stamp is the only source.
 * 2. node dist/bin.js: the package.json sits next to dist/ and is read here.
 * 3. Override: setting AGENTBROWSER_MCP_VERSION in the environment wins in
 *    every mode, for debugging and staged rollouts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read the version from the package.json that sits one level above the given
 * module URL. Returns undefined when there is no readable package file — the
 * compiled-binary case, where package.json is bundled away.
 */
export function readPackageVersion(moduleUrl: string): string | undefined {
  try {
    const here = dirname(fileURLToPath(moduleUrl));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/** Resolve the version this server should report in `serverInfo`. */
export function resolveVersion(env: Record<string, string | undefined> = process.env): string {
  // Keep `process.env.AGENTBROWSER_MCP_VERSION` textually intact: the compile
  // step substitutes this exact expression for the build-time stamp.
  const stamped = process.env.AGENTBROWSER_MCP_VERSION ?? env.AGENTBROWSER_MCP_VERSION;
  if (stamped) {
    return stamped;
  }

  const fromPackage = readPackageVersion(import.meta.url);
  if (fromPackage) {
    return fromPackage;
  }

  // Unstamped compiled binary: the honest answer is 'unknown', not a
  // hardcoded default. The release workflow refuses to ship that.
  return 'unknown';
}
