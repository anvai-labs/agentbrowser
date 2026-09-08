import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { synchronizeVersions } from './sync-versions.mjs';

test('npm publication waits for tag validation and executable/server acceptance', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const job = workflow.split(/\n(?=  [\w-]+:)/).find((block) => block.startsWith('  npm-publish:\n'));
  assert.ok(job, 'Missing npm-publish job');
  const dependencies = job.match(/^    needs: \[([^\]]+)\]\s*$/m)?.[1].split(',').map((value) => value.trim());
  assert.deepEqual(dependencies?.sort(), ['binaries', 'server-packages', 'tag-guard']);
  const server = workflow.split(/\n(?=  [\w-]+:)/).find((block) => block.startsWith('  server-packages:\n'));
  assert.match(server ?? '', /^    needs: \[tag-guard, binaries\]\s*$/m);
});

test('synchronizes manifests and generated runtime stamps; check is non-mutating and catches drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentbrowser-version-test-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '2.3.4-rc.1' }));
    for (const name of ['api', 'cli', 'mcp-server', 'engine']) {
      mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
      writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', private: true }));
    }
    const path = join(root, 'packages', 'api', 'package.json');
    const original = readFileSync(path, 'utf8');
    assert.throws(() => synchronizeVersions(root), /Version drift/);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.equal(synchronizeVersions(root, { write: true }).changed, 6);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, '2.3.4-rc.1');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).private, true);
    assert.equal(synchronizeVersions(root, { tag: 'v2.3.4-rc.1' }).changed, 0);
    assert.throws(() => synchronizeVersions(root, { tag: 'v1.0.0' }), /does not match/);
    writeFileSync(join(root, 'packages', 'api', 'src', 'product-version.ts'), 'stale');
    assert.throws(() => synchronizeVersions(root), /Version drift/);
    for (const version of ['1.2.3-01', '1.2.3-rc..1', '01.2.3', '1.2.3+']) {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
      assert.throws(() => synchronizeVersions(root), /must be semver/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
