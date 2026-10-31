#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditApplicationDeployment } from './application-deployment-audit.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'agentbrowser-application-production-')));
const destination = join(temporary, 'control');


async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, NODE_PATH: '' } });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${code ?? signal}`)));
  });
}


try {
  await run('pnpm', ['--filter', '@agentbrowser/control', 'deploy', '--prod', '--no-optional', destination], root);
  // pnpm 9 retains one selected-workspace self-link. Repair only that verified link.
  const link = join(destination, 'node_modules/.pnpm/node_modules/@agentbrowser/control');
  try {
    assert.ok((await lstat(link)).isSymbolicLink());
    assert.ok((await realpath(dirname(link))).startsWith(destination + sep));
    if (await realpath(link) !== destination) {
      assert.equal(await realpath(link), await realpath(join(root, 'packages/control')));
      await unlink(link);
      await symlink(relative(dirname(link), destination), link);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await auditApplicationDeployment(destination, destination);
  await run(process.execPath, [join(root, 'packages/control/scripts/accept-deployment.mjs'), join(destination, 'dist/index.js')], temporary);
  console.log('PASS: application authority operates from a production tree without API or browser adapters/drivers.');
} finally { await rm(temporary, { recursive: true, force: true }); }
