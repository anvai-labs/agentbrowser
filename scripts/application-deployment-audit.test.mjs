import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditApplicationDeployment } from './application-deployment-audit.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'application-audit-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deployment = join(root, 'deployment');
  await mkdir(deployment);
  return { root, deployment };
}

test('accepts an internal workspace link without a browser dependency', async (t) => {
  const { deployment } = await fixture(t);
  const dependency = join(deployment, 'core');
  await mkdir(dependency);
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: '@agentbrowser/core' }));
  await symlink('core', join(deployment, 'internal-link'));
  await auditApplicationDeployment(deployment, deployment);
});

for (const name of ['playwright-core', 'puppeteer-core', '@agentbrowser/api', '@agentbrowser/engine-firefox']) {
  test(`rejects installed ${name} even when the entrypoint does not import it`, async (t) => {
    const { deployment } = await fixture(t);
    await writeFile(join(deployment, 'package.json'), JSON.stringify({ name }));
    await assert.rejects(auditApplicationDeployment(deployment, deployment), /Browser dependency installed/);
  });
}

test('rejects a dependency link escaping to the source checkout', async (t) => {
  const { root, deployment } = await fixture(t);
  await symlink(root, join(deployment, 'escape'));
  await assert.rejects(auditApplicationDeployment(deployment, deployment), /Escaping dependency/);
});
