import assert from 'node:assert/strict';
import { lstat, readdir, readFile, realpath, symlink, unlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

const forbidden = new Set(['playwright', 'playwright-core', '@agentbrowser/engine-playwright', '@agentbrowser/engine-obscura']);

/** pnpm 9 deploy retains the selected workspace's self-link. Repair only that verified link. */
export async function normalizeFirefoxSelfLink(directory, source) {
  const link = join(directory, 'node_modules/.pnpm/node_modules/@agentbrowser/engine-firefox');
  let entry;
  try { entry = await lstat(link); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.ok(entry.isSymbolicLink(), 'Unexpected Firefox self-reference');
  const boundary = await realpath(directory);
  const parent = await realpath(dirname(link));
  assert.ok(parent.startsWith(boundary + sep), 'Self-link parent escapes deployment');
  const actual = await realpath(link);
  if (actual === boundary) return;
  assert.equal(actual, await realpath(source), 'Unexpected Firefox self-link target');
  await unlink(link);
  await symlink(relative(parent, boundary), link);
}
export async function auditFirefoxDeployment(directory, boundary) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const actual = await realpath(path);
      assert.ok(actual === boundary || actual.startsWith(boundary + sep), `Dependency escapes deployment: ${path}`);
    } else if (entry.isDirectory()) await auditFirefoxDeployment(path, boundary);
    else if (entry.name === 'package.json') {
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      assert.ok(!forbidden.has(manifest.name), `Forbidden runtime dependency: ${manifest.name}`);
    }
  }
}
