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

test('the server deploy closure ships only built output', async () => {
  const seen = new Set();
  const queue = ['api'];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    const pkg = await manifest(dir);
    assert.ok(Array.isArray(pkg.files), `${pkg.name} must declare "files" (it ships in the server tree)`);
    assert.ok(pkg.files.includes('dist'), `${pkg.name} "files" must include dist`);
    for (const entry of pkg.files) {
      assert.ok(!/^(src|coverage|test)/.test(entry) && !/tsconfig|vitest/.test(entry), `${pkg.name} must not ship ${entry}`);
    }
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (dep.startsWith('@agentbrowser/')) queue.push(dirOf(dep));
    }
  }
  assert.ok(seen.size >= 5, `expected the API's workspace closure, saw ${[...seen].join(', ')}`);
});
