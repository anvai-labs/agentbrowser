#!/usr/bin/env node
/**
 * Server entrypoint. Handles the command line first and only then loads the
 * server (main.ts), so `--help`/`--version` work even when the engine stack
 * cannot load — e.g. a broken Playwright install. Configuration is
 * environment-only; see server-args.ts.
 */

import { PRODUCT_VERSION } from './product-version.js';
import { SERVER_HELP, parseServerArgs } from './server-args.js';

const args = parseServerArgs(process.argv.slice(2));
if (args.kind === 'help') {
  process.stdout.write(SERVER_HELP);
} else if (args.kind === 'version') {
  process.stdout.write(`${PRODUCT_VERSION}\n`);
} else if (args.kind === 'error') {
  process.stderr.write(`${args.message}\n`);
  process.exitCode = 2;
} else {
  await import('./main.js');
}
