#!/usr/bin/env node
// Fast local regression loop. CI discovers these tests in its existing Test job.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
function run(args) {
  const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['-r', 'build']);
for (const [pkg, files] of [
  ['core', ['src/session-control.test.ts']],
  ['engine-playwright', ['src/capability-families.test.ts', 'src/input-trust.test.ts', 'src/application-parity.test.ts', 'src/quoted-names.test.ts']],
  ['sdk-typescript', ['src/coexistence.test.ts', 'src/deadline.test.ts']],
  ['cli', ['src/coexistence.test.ts']],
  ['mcp-server', ['src/coexistence.test.ts']],
  [
    'api',
    [
      'src/coexistence.test.ts',
      'src/coexistence-http.test.ts',
      'src/operator-panel.test.ts',
      'src/coexistence-real-chromium.test.ts',
      'src/firefox-deployment.test.ts',
    ],
  ],
])
  run(['--fail-if-no-match', '--filter', `./packages/${pkg}`, 'exec', 'vitest', 'run', ...files]);
