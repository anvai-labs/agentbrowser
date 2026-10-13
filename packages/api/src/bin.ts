#!/usr/bin/env node
/**
 * Server entrypoint. Handles the command line first and only then loads the
 * server (main.ts), so `--help`/`--version` work even when the engine stack
 * cannot load — e.g. a broken Playwright install. Configuration is
 * environment-only; see server-args.ts.
 */

import { PRODUCT_VERSION } from './product-version.js';
import { parseServerArgs, SERVER_HELP } from './server-args.js';

const args = parseServerArgs(process.argv.slice(2));
if (args.kind === 'help') {
  process.stdout.write(SERVER_HELP);
} else if (args.kind === 'version') {
  process.stdout.write(`${PRODUCT_VERSION}\n`);
} else if (args.kind === 'error') {
  process.stderr.write(`${args.message}\n`);
  process.exitCode = 2;
} else if (args.kind === 'policy-export') {
  // Migration path (TD-BROWSER-15 3b): the document for today's environment
  // configuration, so operators move to a policy file by generating one.
  // Loads only the policy stack, never the engine.
  try {
    const { policyDocumentFromEnvironment } = await import('@agentbrowser/policy-engine');
    process.stdout.write(`${JSON.stringify(policyDocumentFromEnvironment(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`agentbrowser-server: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
} else {
  await import('./main.js');
}
