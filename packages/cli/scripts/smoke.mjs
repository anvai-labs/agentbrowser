#!/usr/bin/env node
/**
 * Smoke a compiled CLI binary: `--help` must exit 0 and print the program
 * usage (proves the bundle boots, commander initializes, and the command
 * tree is intact — everything else needs a live service).
 *
 * Usage: node scripts/smoke.mjs <path-to-binary>
 */

import { spawnSync } from 'node:child_process';

const binary = process.argv[2];
if (binary === undefined) {
  console.error('usage: node scripts/smoke.mjs <path-to-binary>');
  process.exit(2);
}

const result = spawnSync(binary, ['--help'], { encoding: 'utf8' });
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

if (result.status !== 0) {
  console.error(`smoke: FAIL - --help exited ${result.status}`);
  console.error(output);
  process.exit(1);
}
for (const expected of ['agentbrowser', 'session', 'act', 'plan']) {
  if (!output.includes(expected)) {
    console.error(`smoke: FAIL - --help output missing '${expected}'`);
    console.error(output);
    process.exit(1);
  }
}

console.log('smoke: PASS - CLI --help OK');
