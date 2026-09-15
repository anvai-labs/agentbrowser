#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefoxExecutable } from '../packages/engine-firefox/scripts/browser-config.mjs';
import { auditFirefoxDeployment, normalizeFirefoxSelfLink } from './firefox-deployment-audit.mjs';
import { startVersionedApp } from '../packages/testkit/dist/index.js';

const executablePath = firefoxExecutable(); // Fail before deploying if absent.
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'agentbrowser-firefox-production-')));
const destination = join(temporary, 'engine');
async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, NODE_PATH: '' } });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${code ?? signal}`)));
  });
}

try {
  await run('pnpm', ['--filter', '@agentbrowser/engine-firefox', 'deploy', '--prod', '--no-optional', destination], root);
  await normalizeFirefoxSelfLink(destination, join(root, 'packages/engine-firefox'));
  await auditFirefoxDeployment(destination, await realpath(destination));
  const fixture = await startVersionedApp();
  try {
    await run(process.execPath, [join(root, 'packages/engine-firefox/scripts/accept-deployment.mjs'), join(destination, 'dist/index.js'), executablePath, fixture.url], temporary);
    assert.deepEqual(fixture.oracle.snapshot(), { version: 1, total: 1 });
    console.log('PASS: production Firefox tree has no Playwright; real BiDi action and PNG capture verified.');
  } finally { await fixture.close(); }
} finally { await rm(temporary, { recursive: true, force: true }); }
