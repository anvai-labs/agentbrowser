#!/usr/bin/env node
/** Same server packaging for untagged candidates and releases; never publishes. */
import assert from 'node:assert/strict';
import { copyFile, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, win32 as windowsPath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runExecutable } from './release-smoke.mjs';
import { materializeHoisted } from './materialize-hoisted.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];

// Windows cannot extract pnpm's symlinked layout (tar fails on every link
// without Developer Mode). The win32 tree is the same lockfile-faithful
// isolated deploy as every other target, rewritten link-free by
// materialize-hoisted.mjs (pnpm 9's own hoisted deploy ignores the lockfile).
const WIN32 = 'win32-x64';
// Never loaded at runtime; pruning them keeps the tree small and paths short.
const DEV_ONLY_FILE = /\.(?:map|d\.ts|d\.mts|d\.cts)$/;
// MAX_PATH budget. winget installs portable packages under
//   C:\Users\<user>\AppData\Local\Microsoft\WinGet\Packages\
//   AnvaiLabs.AgentBrowser_Microsoft.Winget.Source_8wekyb3d8bbwe\
// = 9 + 102 = 111 characters plus the user name (20: the SAM account-name
// limit; longer profile folders such as user.DOMAIN.000 are out of budget).
// Files: MAX_PATH is 260 including the terminating NUL, so 259 usable:
//   111 + 20 + 125 = 256 <= 259.
// Directories: CreateDirectory allows 248 including NUL, so 247 usable:
//   111 + 20 + 116 = 247.
// Both are measured relative to the archive root, so they include `server/`.
const MAX_WIN32_RELATIVE_PATH = 125;
const MAX_WIN32_RELATIVE_DIR = 116;

// pnpm is a .cmd shim on Windows: libuv cannot spawn it without a shell, and
// Node 24 refuses to spawn .cmd files without one. Prefer the pnpm that is
// already running us (npm_execpath), then cmd.exe with checked arguments.
export function pnpmCommand(args, { platform = process.platform, env = process.env } = {}) {
  const execpath = env.npm_execpath;
  if (execpath && /pnpm/i.test(basename(execpath)) && /\.(?:c?js|mjs)$/i.test(execpath)) {
    return [process.execPath, execpath, ...args];
  }
  if (platform === 'win32') {
    for (const arg of args) {
      assert.ok(!/[\s"&|<>^%!()]/.test(arg), `Unsafe pnpm argument for cmd.exe: ${arg}`);
    }
    return ['cmd.exe', '/d', '/s', '/c', 'pnpm', ...args];
  }
  return ['pnpm', ...args];
}

async function walk(dir, visit) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // Directory entries are not followed through links: lstat semantics
    // (withFileTypes) report junctions and symlinks as isSymbolicLink().
    if ((await visit(path, entry)) === 'skip') continue;
    if (entry.isDirectory()) await walk(path, visit);
  }
}

// Remove what a server never needs and Windows cannot carry: .bin link shims
// (at any depth) and type/source-map files. Then prove the tree is link-free
// and fits the MAX_PATH budget.
async function prepareWin32Tree(staging, server) {
  await walk(server, async (path, entry) => {
    if (entry.name === '.bin' && basename(dirname(path)) === 'node_modules') {
      await rm(path, { recursive: true, force: true });
      return 'skip';
    }
    if (entry.isFile() && DEV_ONLY_FILE.test(entry.name)) await unlink(path);
    return undefined;
  });
  const links = [];
  let longest = '';
  let longestDir = '';
  await walk(server, async (path, entry) => {
    const rel = relative(staging, path).split('\\').join('/');
    if (entry.isSymbolicLink()) links.push(rel);
    if (rel.length > longest.length) longest = rel;
    if (entry.isDirectory() && rel.length > longestDir.length) longestDir = rel;
  });
  assert.deepEqual(links, [], `Windows server tree must not contain links or junctions: ${links.slice(0, 5).join(', ')}`);
  assert.ok(
    longest.length <= MAX_WIN32_RELATIVE_PATH,
    `Windows server path too long for MAX_PATH (${longest.length} > ${MAX_WIN32_RELATIVE_PATH}): ${longest}`
  );
  assert.ok(
    longestDir.length <= MAX_WIN32_RELATIVE_DIR,
    `Windows server directory path too long for CreateDirectory (${longestDir.length} > ${MAX_WIN32_RELATIVE_DIR}): ${longestDir}`
  );
}

/**
 * Where to stage. On Windows, pnpm deploy fails when the target is on another
 * drive than the workspace (hosted runners check out to D: with %TEMP% on
 * C:), so stage beside the checkout instead — same drive, outside the tree.
 */
export function stagingBase(root, { platform = process.platform, temp = tmpdir() } = {}) {
  if (platform !== 'win32') return temp;
  const drive = (path) => windowsPath.parse(windowsPath.resolve(path)).root.toLowerCase();
  return drive(temp) === drive(root) ? temp : windowsPath.dirname(windowsPath.resolve(root));
}

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

export async function packageServer({ root = ROOT, outputDir, target, expectedVersion, commit, allowDirty = false, run = runExecutable, platform = process.platform, env = process.env, materialize = materializeHoisted, temp = tmpdir() }) {
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
    staging = await mkdtemp(join(stagingBase(root, { platform, temp }), 'agentbrowser-package-'));
    staging = await realpath(staging);
    const server = join(staging, 'server');
    const win32 = target === WIN32;
    // Every target starts from the same lockfile-faithful isolated deploy.
    const deployed = win32 ? join(staging, 'isolated') : server;
    const deploy = ['--dir', root, '--filter', '@agentbrowser/api', 'deploy', '--prod', deployed];
    await run(pnpmCommand(deploy, { platform, env }), {
      timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024, diagnostics: true,
    });
    const manifest = JSON.parse(await readFile(join(deployed, 'package.json'), 'utf8'));
    assert.equal(manifest.version, expectedVersion, 'Deployed server version mismatch');
    await normalizeSelfLink(deployed, root);
    let packages;
    if (win32) {
      ({ packages } = await materialize(deployed, server));
      await rm(deployed, { recursive: true, force: true });
    }
    await writeFile(join(server, 'VERSION.json'), `${JSON.stringify({ version, commit, dirty }, null, 2)}\n`);
    let file;
    if (win32) {
      // The Windows bundle supplies its own launcher; no POSIX sh script here.
      await prepareWin32Tree(staging, server);
      file = join(destination, `agentbrowser-server-${target}.zip`);
      if (platform === 'win32') {
        // Explicit path: Git for Windows' GNU tar on PATH cannot write zip.
        const tarExe = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
        await run([tarExe, '-a', '-c', '-f', file, '-C', staging, 'server'], { timeoutMs: 300_000, diagnostics: true });
      } else {
        // Cross-build (e.g. WSL/Linux CI): the tree is pure JavaScript.
        await run(['zip', '-q', '-r', '-X', file, 'server'], { cwd: staging, timeoutMs: 300_000, diagnostics: true });
      }
    } else {
      await copyFile(join(root, 'scripts', 'agentbrowser-server'), join(server, 'agentbrowser-server'));
      await chmod(join(server, 'agentbrowser-server'), 0o755);
      file = join(destination, `agentbrowser-server-${target}.tar.gz`);
      await run(['tar', '-czf', file, '-C', staging, 'server'], { timeoutMs: 120_000 });
    }
    complete = true;
    return { file, version, commit, dirty, target, ...(packages ? { packages: packages.length } : {}) };
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
