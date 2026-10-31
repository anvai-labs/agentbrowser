import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

// Every workspace package the server deploys must allowlist its built output.
// Without `files`, pnpm deploy copies the whole package directory into every
// server artifact (tarballs, the Windows zip, the Docker image): src/,
// tsconfig*, vitest configs and, on a machine that has run tests, coverage/
// reports embedding the build checkout's absolute paths.
const manifest = async (name) =>
  JSON.parse(await readFile(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8'));
const dirOf = (pkg) => pkg.replace('@agentbrowser/', '');

// Exact allowlists only: a glob such as "*" or "./src" would pass any
// prefix-based check while shipping everything.
const ALLOWED = [JSON.stringify(['dist']), JSON.stringify(['dist', 'README.md'])];

export async function deployClosure() {
  const seen = new Map();
  const queue = ['api'];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    const pkg = await manifest(dir);
    seen.set(dir, pkg);
    // Same edges as the extracted-package audit: optional and peer
    // workspace dependencies deploy too.
    for (const deps of [pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies]) {
      for (const dep of Object.keys(deps ?? {}))
        if (dep.startsWith('@agentbrowser/')) queue.push(dirOf(dep));
    }
  }
  return seen;
}

test('the server deploy closure ships only built output', async () => {
  const closure = await deployClosure();
  for (const pkg of closure.values()) {
    assert.ok(
      ALLOWED.includes(JSON.stringify(pkg.files)),
      `${pkg.name} must declare "files": ["dist"] (or ["dist", "README.md"]); got ${JSON.stringify(pkg.files)}`
    );
  }
  assert.ok(
    closure.has('engine-playwright') && closure.has('protocol') && closure.size >= 9,
    `expected the API's full workspace closure, saw ${[...closure.keys()].join(', ')}`
  );
});

test('the allowlist check rejects widened or missing allowlists', () => {
  for (const files of [undefined, ['dist', '*'], ['./src', 'dist'], ['dist', 'src'], ['lib']]) {
    assert.ok(!ALLOWED.includes(JSON.stringify(files)), JSON.stringify(files));
  }
});
