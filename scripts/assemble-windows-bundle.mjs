#!/usr/bin/env node
/**
 * Assemble the Windows bundle: agentbrowser-windows-x64.zip, flat (no top
 * folder), which winget installs as one portable package:
 *
 *   agentbrowser-server.exe   launcher (packages/api/src/launcher, Bun-compiled)
 *   agentbrowser-cli.exe      CLI (Bun-compiled)
 *   agentbrowser-mcp.exe      MCP adapter (Bun-compiled)
 *   node\node.exe, LICENSE    pinned official Node (scripts/windows-node.json)
 *   server\                   win32-x64 server tree (scripts/package-server.mjs)
 *
 * Gates before anything is written: the server tree matches the release
 * version, the bundle holds no links, no shipped file embeds a build-machine
 * path (the v1.17.0 failure), and every path fits the MAX_PATH budget.
 *
 *   node scripts/assemble-windows-bundle.mjs --output-dir <dir> --expected-version <v>
 *        --server-zip <zip> --launcher <exe> --cli <exe> --mcp <exe>
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { scanShippedPaths } from './check-shipped-paths.mjs';
import { findLinks } from './check-win32-server-tree.mjs';
import { fetchWindowsNode } from './fetch-windows-node.mjs';
import { MAX_WIN32_RELATIVE_DIR, MAX_WIN32_RELATIVE_PATH, stagingBase } from './package-server.mjs';
import { runExecutable } from './release-smoke.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const BUNDLE = 'agentbrowser-windows-x64.zip';
const ENTRIES = [
  'agentbrowser-cli.exe',
  'agentbrowser-mcp.exe',
  'agentbrowser-server.exe',
  'node',
  'server',
];

const tarExe = (env) => join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

async function longestPaths(dir, top = dir, acc = { file: '', dir: '' }) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(top, path).split('\\').join('/');
    if (entry.isDirectory()) {
      if (rel.length > acc.dir.length) acc.dir = rel;
      await longestPaths(path, top, acc);
    } else if (rel.length > acc.file.length) acc.file = rel;
  }
  return acc;
}

export async function assembleWindowsBundle({
  root = ROOT,
  outputDir,
  expectedVersion,
  serverZip,
  launcher,
  cli,
  mcp,
  platform = process.platform,
  env = process.env,
  run = runExecutable,
  fetchNode = fetchWindowsNode,
  temp = tmpdir(),
}) {
  assert.ok(outputDir && expectedVersion, '--output-dir and --expected-version are required');
  for (const [flag, path] of Object.entries({ 'server-zip': serverZip, launcher, cli, mcp })) {
    assert.ok(path && (await stat(path)).isFile(), `--${flag} must name an existing file`);
  }
  const destination = resolve(outputDir);
  await mkdir(destination); // refuses an existing directory: never overwrite a candidate
  let staging;
  let complete = false;
  try {
    staging = await realpath(
      await mkdtemp(join(stagingBase(root, { platform, temp }), 'agentbrowser-bundle-'))
    );
    const bundle = join(staging, 'bundle');
    await mkdir(bundle);
    await copyFile(launcher, join(bundle, 'agentbrowser-server.exe'));
    await copyFile(cli, join(bundle, 'agentbrowser-cli.exe'));
    await copyFile(mcp, join(bundle, 'agentbrowser-mcp.exe'));
    const node = await fetchNode({ destination: join(bundle, 'node') });
    const extract =
      platform === 'win32'
        ? [tarExe(env), '-x', '-f', resolve(serverZip), '-C', bundle]
        : ['unzip', '-q', resolve(serverZip), '-d', bundle];
    await run(extract, { timeoutMs: 300_000, diagnostics: true });

    const stamp = JSON.parse(await readFile(join(bundle, 'server', 'VERSION.json'), 'utf8'));
    assert.equal(
      stamp.version,
      expectedVersion,
      `server tree is ${stamp.version}, expected ${expectedVersion}`
    );
    const links = await findLinks(bundle);
    assert.deepEqual(links, [], `bundle contains a link: ${links.slice(0, 5).join(', ')}`);
    const leaks = await scanShippedPaths(bundle, { checkout: root, exclude: ['node'] });
    assert.deepEqual(
      leaks.map((leak) => `${leak.file}: ${leak.needle}`),
      [],
      'bundle embeds a build-machine path'
    );
    const longest = await longestPaths(bundle);
    assert.ok(
      longest.file.length <= MAX_WIN32_RELATIVE_PATH,
      `path too long for MAX_PATH: ${longest.file}`
    );
    assert.ok(
      longest.dir.length <= MAX_WIN32_RELATIVE_DIR,
      `directory too long for MAX_PATH: ${longest.dir}`
    );

    const file = join(destination, BUNDLE);
    // Flat zip: entries are named from the bundle root (tar -C / zip cwd).
    if (platform === 'win32') {
      await run([tarExe(env), '-a', '-c', '-f', file, '-C', bundle, ...ENTRIES], {
        timeoutMs: 600_000,
        diagnostics: true,
      });
    } else {
      await run(['zip', '-q', '-r', file, ...ENTRIES], {
        cwd: bundle,
        timeoutMs: 600_000,
        diagnostics: true,
      });
    }
    const sha256 = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
    complete = true;
    return {
      bundle: 'PASS',
      file,
      sha256,
      version: expectedVersion,
      commit: stamp.commit,
      node: node.version,
    };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    if (!complete) await rm(destination, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(
        ['output-dir', 'expected-version', 'server-zip', 'launcher', 'cli', 'mcp'].map((k) => [
          k,
          { type: 'string' },
        ])
      ),
    });
    console.log(
      JSON.stringify(
        await assembleWindowsBundle({
          outputDir: values['output-dir'],
          expectedVersion: values['expected-version'],
          serverZip: values['server-zip'],
          launcher: values.launcher,
          cli: values.cli,
          mcp: values.mcp,
        })
      )
    );
  } catch (error) {
    console.error(`windows bundle: FAIL - ${error.message}`);
    process.exitCode = 1;
  }
}
