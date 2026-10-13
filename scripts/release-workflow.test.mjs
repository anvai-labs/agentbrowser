import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

// Structural guards on the release workflow: the Windows service ships only
// as the bundled-Node zip. v1.17.0's single-file server exe (Bun froze
// Playwright's __dirname to the CI checkout) must not come back.
const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

/** The text of one top-level job (from its key to the next job key). */
function job(name) {
  const start = workflow.search(new RegExp(`^  ${name}:$`, 'm'));
  assert.ok(start >= 0, `release.yml has no ${name} job`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^ {2}[a-z][a-z0-9-]*:$/m);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

const needs = (name) => (job(name).match(/^ {4}needs: \[([^\]]*)\]/m)?.[1] ?? '').split(',').map((n) => n.trim());

test('no single-file server executable is built or published', () => {
  assert.doesNotMatch(workflow, /server_artifact|packages\/api\/scripts\/compile\.mjs|agentbrowser-server-windows-x64\.exe/);
});

test('a windows-bundle job assembles and clean-room smokes the zip on Windows', () => {
  const bundle = job('windows-bundle');
  assert.match(bundle, /runs-on: windows-/);
  assert.match(bundle, /scripts\/package-server\.mjs[^\n]*--target win32-x64/);
  assert.match(bundle, /compile-launcher\.mjs/);
  assert.match(bundle, /scripts\/assemble-windows-bundle\.mjs/);
  assert.match(bundle, /windows-bundle-smoke\.mjs[\s\S]*--require-symlink/);
  // The bundle carries the exact standalone CLI/MCP bytes built by `binaries`.
  assert.match(bundle, /agentbrowser-cli-windows-x64\.exe/);
  assert.match(bundle, /agentbrowser-mcp-windows-x64\.exe/);
  assert.ok(needs('windows-bundle').includes('binaries'));
  assert.match(bundle, /name: agentbrowser-windows-x64\.zip/);
});

test('nothing publishes unless the Windows bundle passed', () => {
  for (const publisher of ['npm-publish', 'release']) {
    assert.ok(needs(publisher).includes('windows-bundle'), `${publisher} must need windows-bundle`);
  }
});

test('the release job no longer builds its own flat zip, and checksums the bundle', () => {
  const release = job('release');
  assert.doesNotMatch(release, /zip -X -j/);
  assert.match(release, /sha256sum[^\n]*agentbrowser-windows-x64\.zip/);
});
