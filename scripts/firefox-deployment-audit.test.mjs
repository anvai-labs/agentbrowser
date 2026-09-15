import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditFirefoxDeployment, normalizeFirefoxSelfLink } from './firefox-deployment-audit.mjs';

test('independence audit rejects hidden Playwright packages and dependency symlinks outside the deployment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firefox-audit-'));
  try {
    const boundary = await realpath(root);
    const nested = join(root, 'node_modules/.pnpm/hidden');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'package.json'), JSON.stringify({ name: 'puppeteer-core' }));
    await auditFirefoxDeployment(root, boundary);
    await writeFile(join(nested, 'package.json'), JSON.stringify({ name: 'playwright-core' }));
    await assert.rejects(auditFirefoxDeployment(root, boundary), /Forbidden runtime dependency/);
    await writeFile(join(nested, 'package.json'), JSON.stringify({ name: 'puppeteer-core' }));
    await symlink(tmpdir(), join(root, 'escaped-dependency'));
    await assert.rejects(auditFirefoxDeployment(root, boundary), /Dependency escapes deployment/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('normalizes only a verified pnpm workspace self-link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firefox-self-link-'));
  try {
    const deployment = join(root, 'deployment'), source = join(root, 'source');
    const parent = join(deployment, 'node_modules/.pnpm/node_modules/@agentbrowser');
    const link = join(parent, 'engine-firefox');
    await mkdir(parent, { recursive: true });
    await mkdir(source);
    await symlink(source, link);
    await assert.rejects(normalizeFirefoxSelfLink(deployment, root), /Unexpected Firefox self-link target/);
    await normalizeFirefoxSelfLink(deployment, source);
    assert.equal(await realpath(link), await realpath(deployment));
    await auditFirefoxDeployment(deployment, await realpath(deployment));
  } finally { await rm(root, { recursive: true, force: true }); }
});
