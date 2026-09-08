#!/usr/bin/env node
/** Version-aware executable smoke; accepts --expected-version for installed releases. */
import { runSmokeCommand } from '../../../scripts/release-smoke.mjs';

await runSmokeCommand('mcp', process.argv.slice(2), new URL('../package.json', import.meta.url));
