#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { firefoxExecutable } from '../packages/engine-firefox/scripts/browser-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, AGENTBROWSER_FIREFOX_EXECUTABLE: firefoxExecutable() };
function run(args) {
  const result = spawnSync('pnpm', args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['--filter', '@agentbrowser/engine-firefox...', 'build']);
run(['exec', 'node', '--test', 'scripts/browser-egress-gate.test.mjs']);
run(['--filter', '@agentbrowser/testkit', 'exec', 'vitest', 'run', 'src/versioned-app.test.ts']);
run(['--filter', '@agentbrowser/engine-firefox', 'test']);
run(['--filter', '@agentbrowser/engine-playwright', 'exec', 'vitest', 'run', 'src/application-parity.test.ts']);
