#!/usr/bin/env node
/** Same server packaging for untagged candidates and releases; never publishes. */
import assert from 'node:assert/strict';
import { copyFile, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runExecutable } from './release-smoke.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];

async function normalizeSelfLink(server, root) {
  // pnpm 9 deploy retains this API self-reference to the source checkout.
  // Repair only the verified self-link, inside our newly owned staging tree.
  const link = join(server, 'node_modules/.pnpm/node_modules/@agentbrowser/api');
  let entry;
  try { entry = await lstat(link); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.ok(entry.isSymbolicLink(), 'Unexpected deployed API self-reference');
  const physicalServer = await realpath(server);
  const parent = await realpath(dirname(link));
  const suffix = relative(physicalServer, parent);
  assert.ok(suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix), 'Deployed API self-link parent escapes staging');
  const actual = await realpath(link);
  if (actual === physicalServer) return;
  assert.equal(actual, await realpath(join(root, 'packages/api')), 'Unexpected deployed API self-link target');
  await unlink(link);
  await symlink(relative(parent, physicalServer), link);
}

export async function packageServer({ root = ROOT, outputDir, target, expectedVersion, commit, allowDirty = false, run = runExecutable }) {
  assert.ok(TARGETS.includes(target), 'Unsupported server target');
  assert.ok(outputDir, 'An unused output directory is required');
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(version, expectedVersion, 'Candidate version mismatch');
  const head = (await run(['git', '-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  assert.match(head, /^[a-f0-9]{40}$/, 'Expected a full checkout commit SHA');
  assert.equal(commit ?? head, head, 'Supplied commit does not match checkout HEAD');
  commit = head;
  const dirty = (await run(['git', '-C', root, 'status', '--porcelain', '--untracked-files=normal'])).stdout.trim().length > 0;
  assert.ok(!dirty || allowDirty, 'Dirty checkout: use --allow-dirty only for explicitly unverified local testing');
  const destination = resolve(outputDir);
  // Nonrecursive mkdir deliberately refuses any existing destination. Never
  // overwrite a previous candidate or remove a caller-owned directory on error.
  await mkdir(destination);
  let staging;
  let complete = false;
  try {
    // macOS /var is a symlink to /private/var. pnpm computes relative links;
    // give it the physical path so those links are valid before normalization.
    staging = await mkdtemp(join(tmpdir(), 'agentbrowser-package-'));
    staging = await realpath(staging);
    const server = join(staging, 'server');
    await run(['pnpm', '--dir', root, '--filter', '@agentbrowser/api', 'deploy', '--prod', server], {
      timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024,
    });
    const manifest = JSON.parse(await readFile(join(server, 'package.json'), 'utf8'));
    assert.equal(manifest.version, expectedVersion, 'Deployed server version mismatch');
    await normalizeSelfLink(server, root);
    await writeFile(join(server, 'VERSION.json'), `${JSON.stringify({ version, commit, dirty }, null, 2)}\n`);
    await copyFile(join(root, 'scripts', 'agentbrowser-server'), join(server, 'agentbrowser-server'));
    await chmod(join(server, 'agentbrowser-server'), 0o755);
    const file = join(destination, `agentbrowser-server-${target}.tar.gz`);
    await run(['tar', '-czf', file, '-C', staging, 'server'], { timeoutMs: 120_000 });
    complete = true;
    return { file, version, commit, dirty, target };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    if (!complete) await rm(destination, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: {
      'output-dir': { type: 'string' }, target: { type: 'string' },
      'expected-version': { type: 'string' }, commit: { type: 'string' },
      'allow-dirty': { type: 'boolean', default: false },
    } });
    const report = await packageServer({
      outputDir: values['output-dir'], target: values.target,
      expectedVersion: values['expected-version'], commit: values.commit,
      allowDirty: values['allow-dirty'],
    });
    console.log(JSON.stringify({ packaging: 'PASS', ...report }));
  } catch (error) {
    console.error(`packaging: FAIL - ${error.message}`);
    process.exitCode = 1;
  }
}
