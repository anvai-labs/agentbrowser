import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { packageServer, stagingBase } from './package-server.mjs';
import { runExecutable } from './release-smoke.mjs';

const gitReply = (args, dirty = false) => args[0] === 'git'
  ? { stdout: args[3] === 'rev-parse' ? 'a'.repeat(40) : dirty ? ' M changed-source.ts\n' : '', stderr: '' }
  : undefined;

test('Docker installs every workspace manifest before copying sources and building', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const install = dockerfile.indexOf('RUN pnpm install --frozen-lockfile');
  assert.ok(install > 0, 'Docker must install the frozen workspace');
  const manifestLayer = dockerfile.slice(0, install).split('\n');
  const packages = new URL('../packages/', import.meta.url);
  for (const directory of await readdir(packages, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    try { await stat(new URL(`${directory.name}/package.json`, packages)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const manifest = `packages/${directory.name}/package.json`;
    assert.ok(manifestLayer.includes(`COPY ${manifest} packages/${directory.name}/`), `Docker dependency layer omits ${manifest}`);
  }
  assert.ok(dockerfile.indexOf('COPY packages packages') > install);
});

test('Docker smoke probes its owned container without a shared host port or name', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const smoke = workflow.slice(workflow.indexOf('- name: Run read-only smoke test'), workflow.indexOf('\n  benchmarks:'));
  assert.doesNotMatch(smoke, /--name agentbrowser-smoke|-p 5709:5709|curl .*127\.0\.0\.1/);
  assert.match(smoke, /docker exec "\$CONTAINER_ID" node/);
  assert.match(smoke, /trap .*docker rm -f "\$CONTAINER_ID".* EXIT/);
});

test('PR and release CI share the packager and real packaged acceptance before publication', async () => {
  for (const name of ['ci', 'release']) {
    const workflow = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    assert.match(workflow, /node scripts\/package-server\.mjs/);
    assert.match(workflow, /node scripts\/package-acceptance\.mjs/);
    assert.match(workflow, /--expected-version/);
    assert.match(workflow, /--expected-commit "\$GITHUB_SHA"/);
    assert.doesNotMatch(workflow, /--allow-dirty/);
    assert.match(workflow, /trap 'rm -rf -- "\$EXTRACTED"' EXIT/);
  }
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(release, /target: bun-linux-arm64\s+os: ubuntu-24\.04-arm[\s\S]*?smoke: true/);
  assert.doesNotMatch(release, /\/tmp\/abserver|navigate to example\.com/);
});

async function fixture(exercise) {
  const root = await mkdtemp(join(tmpdir(), 'agentbrowser-package-test-'));
  try {
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    await writeFile(join(root, 'scripts', 'agentbrowser-server'), '#!/bin/sh\nexit 0\n');
    await exercise(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('packages deployed bytes with exact version/commit and a shared launcher', async () => {
  await fixture(async (root) => {
    const calls = [];
    const run = async (args) => {
      const git = gitReply(args);
      if (git) return git;
      calls.push(args);
      if (args[0] === 'pnpm') {
        const server = args.at(-1);
        await mkdir(server);
        assert.equal(server, await realpath(server), 'Deployment must use a physical staging path');
        await writeFile(join(server, 'package.json'), JSON.stringify({ version: '1.2.3' }));
        await mkdir(join(root, 'packages/api'), { recursive: true });
        await mkdir(join(server, 'node_modules/.pnpm/node_modules/@agentbrowser'), { recursive: true });
        await symlink(join(root, 'packages/api'), join(server, 'node_modules/.pnpm/node_modules/@agentbrowser/api'));
      } else if (args[0] === 'tar') {
        const server = join(args.at(-2), 'server');
        assert.deepEqual(JSON.parse(await readFile(join(server, 'VERSION.json'))), {
          version: '1.2.3', commit: 'a'.repeat(40), dirty: false,
        });
        assert.match(await readFile(join(server, 'agentbrowser-server'), 'utf8'), /^#!\/bin\/sh/);
        assert.equal(await realpath(join(server, 'node_modules/.pnpm/node_modules/@agentbrowser/api')), await realpath(server), 'Deployed self-link must not retain a workspace dependency');
        await writeFile(args[2], 'fixture archive');
      }
      return { stdout: '', stderr: '' };
    };
    const result = await packageServer({ root, outputDir: join(root, 'out'), target: 'linux-x64', expectedVersion: '1.2.3', commit: 'a'.repeat(40), run });
    assert.equal(result.file, join(root, 'out', 'agentbrowser-server-linux-x64.tar.gz'));
    assert.equal(calls[0][0], 'pnpm');
    assert.equal(calls[1][0], 'tar');
    await assert.rejects(stat(dirname(calls[0].at(-1))), /ENOENT/);
  });
});

test('refuses existing output, invalid targets and version drift before deployment', async () => {
  await fixture(async (root) => {
    const base = { root, outputDir: join(root, 'out'), target: 'linux-x64', expectedVersion: '1.2.3', commit: 'a'.repeat(40), run: async (args) => {
      const git = gitReply(args);
      if (git) return git;
      throw new Error('must not deploy');
    } };
    await assert.rejects(packageServer({ ...base, target: '../escape' }), /target/);
    await assert.rejects(packageServer({ ...base, expectedVersion: '9.9.9' }), /version/);
    await mkdir(base.outputDir);
    await writeFile(join(base.outputDir, 'keep'), 'user bytes');
    await assert.rejects(packageServer(base), /exist/i);
    assert.equal(await readFile(join(base.outputDir, 'keep'), 'utf8'), 'user bytes');
  });
});

test('rejects an escaping self-link parent without mutating the outside link', async () => {
  await fixture(async (root) => {
    const outside = join(root, 'outside');
    const source = join(root, 'packages/api');
    await mkdir(outside);
    await mkdir(source, { recursive: true });
    await symlink(source, join(outside, 'api'));
    const run = async (args) => {
      const git = gitReply(args);
      if (git) return git;
      if (args[0] === 'pnpm') {
        const server = args.at(-1);
        await mkdir(join(server, 'node_modules/.pnpm/node_modules'), { recursive: true });
        await writeFile(join(server, 'package.json'), JSON.stringify({ version: '1.2.3' }));
        await symlink(outside, join(server, 'node_modules/.pnpm/node_modules/@agentbrowser'));
      }
      return { stdout: '', stderr: '' };
    };
    await assert.rejects(packageServer({ root, run, outputDir: join(root, 'out'), target: 'linux-x64', expectedVersion: '1.2.3' }), /self-link parent/);
    assert.equal(await readlink(join(outside, 'api')), source);
  });
});

test('failed packaging cleans its own staging and output, preserving the parent', async () => {
  await fixture(async (root) => {
    let staging;
    const outputDir = join(root, 'out');
    await assert.rejects(packageServer({ root, outputDir, target: 'linux-x64', expectedVersion: '1.2.3', commit: 'a'.repeat(40), run: async (args) => {
      const git = gitReply(args);
      if (git) return git;
      staging = args.at(-1);
      throw new Error('injected deploy failure');
    } }), /injected deploy failure/);
    await assert.rejects(stat(dirname(staging)), /ENOENT/);
    await assert.rejects(stat(outputDir), /ENOENT/);
    assert.equal(JSON.parse(await readFile(join(root, 'package.json'))).version, '1.2.3');
  });
});

test('explicit local dirty builds carry dirty provenance in both archive and report', async () => {
  await fixture(async (root) => {
    const run = async (args) => {
      const git = gitReply(args, true);
      if (git) return git;
      if (args[0] === 'pnpm') {
        await mkdir(args.at(-1));
        await writeFile(join(args.at(-1), 'package.json'), JSON.stringify({ version: '1.2.3' }));
      } else if (args[0] === 'tar') {
        const stamp = JSON.parse(await readFile(join(args.at(-2), 'server', 'VERSION.json')));
        assert.equal(stamp.dirty, true);
        assert.equal(stamp.commit, 'a'.repeat(40));
        await writeFile(args[2], 'local archive');
      }
      return { stdout: '', stderr: '' };
    };
    const result = await packageServer({ root, run, outputDir: join(root, 'out'), target: 'linux-x64', expectedVersion: '1.2.3', allowDirty: true });
    assert.equal(result.dirty, true);
  });
});

test('refuses wrong checkout attribution and dirty candidates before deployment', async () => {
  await fixture(async (root) => {
    const base = { root, outputDir: join(root, 'out'), target: 'linux-x64', expectedVersion: '1.2.3' };
    const run = async (args) => {
      const git = gitReply(args, true);
      if (git) return git;
      throw new Error('must not deploy');
    };
    await assert.rejects(packageServer({ ...base, run, commit: 'b'.repeat(40) }), /does not match/);
    await assert.rejects(packageServer({ ...base, run }), /Dirty checkout/);
  });
});

// --- win32-x64: symlink-free hoisted tree (Windows cannot extract pnpm links) ---

// Stands in for materialize-hoisted.mjs (tested on its own): copies the
// deployed fixture verbatim, links included, so the win32 gates still see them.
const materializeCalls = [];
async function copyTree(from, to) {
  materializeCalls.push([from, to]);
  await cp(from, to, { recursive: true, verbatimSymlinks: true });
  return { packages: ['fastify@5.0.0'] };
}

async function hoistedDeploy(server, { extraLink, longPath } = {}) {
  await mkdir(join(server, 'node_modules/.bin'), { recursive: true });
  await mkdir(join(server, 'node_modules/fastify/node_modules/.bin'), { recursive: true });
  await mkdir(join(server, 'dist'), { recursive: true });
  await writeFile(join(server, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(join(server, 'dist/bin.js'), 'export {};\n');
  await writeFile(join(server, 'dist/bin.d.ts'), 'export {};\n');
  await writeFile(join(server, 'dist/bin.js.map'), '{}');
  await writeFile(join(server, 'node_modules/fastify/index.js'), 'module.exports = {};\n');
  await writeFile(join(server, 'node_modules/fastify/index.d.mts'), 'export {};\n');
  await writeFile(join(server, 'node_modules/fastify/types.d.cts'), 'export {};\n');
  // pnpm (hoisted) still writes .bin shims; they are links and useless to a server.
  await symlink('../fastify/index.js', join(server, 'node_modules/.bin/fastify'));
  await symlink('../index.js', join(server, 'node_modules/fastify/node_modules/.bin/nested'));
  if (extraLink) await symlink('fastify', join(server, 'node_modules/alias'));
  if (longPath) {
    const deep = join(server, 'node_modules', 'x'.repeat(60), 'node_modules', 'y'.repeat(60));
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'index.js'), '');
  }
}

async function listTree(dir, prefix = '') {
  const entries = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    entries.push(entry.isSymbolicLink() ? `${rel}@` : rel);
    if (entry.isDirectory()) entries.push(...(await listTree(join(dir, entry.name), rel)));
  }
  return entries;
}

test('win32-x64 deploys hoisted, strips links and dev-only files, and zips without a POSIX launcher', async () => {
  await fixture(async (root) => {
    const calls = [];
    let archivedTree;
    const run = async (args, options = {}) => {
      const git = gitReply(args);
      if (git) return git;
      calls.push({ args, options });
      if (args.includes('deploy')) {
        await hoistedDeploy(args.at(-1));
      } else if (args[0] === 'zip') {
        archivedTree = await listTree(join(options.cwd, 'server'));
        await writeFile(args.at(-2), 'zip bytes');
      }
      return { stdout: '', stderr: '' };
    };
    const result = await packageServer({ root, run, platform: 'linux', outputDir: join(root, 'out'), target: 'win32-x64', materialize: copyTree, expectedVersion: '1.2.3', commit: 'a'.repeat(40) });
    assert.equal(result.file, join(root, 'out', 'agentbrowser-server-win32-x64.zip'));
    assert.equal(result.packages, 1);
    const deploy = calls.find(({ args }) => args.includes('deploy')).args;
    // pnpm 9's hoisted deploy ignores the lockfile: win32 must start from the
    // same isolated deploy as every other target, then materialize it.
    assert.ok(!deploy.some((arg) => arg.includes('node-linker')), 'win32 must use the lockfile-faithful isolated deploy');
    const [from, to] = materializeCalls.at(-1);
    assert.equal(from, deploy.at(-1));
    assert.equal(basename(to), 'server');
    assert.notEqual(from, to);
    assert.ok(archivedTree.includes('VERSION.json'));
    assert.ok(archivedTree.includes('dist/bin.js'));
    assert.ok(!archivedTree.includes('agentbrowser-server'), 'no POSIX sh launcher in the Windows tree');
    assert.deepEqual(archivedTree.filter((p) => p.endsWith('@')), [], 'no symlinks/junctions may ship');
    assert.deepEqual(archivedTree.filter((p) => /(^|\/)\.bin(\/|$)/.test(p)), [], '.bin shims removed');
    assert.deepEqual(archivedTree.filter((p) => /\.(map|d\.ts|d\.mts|d\.cts)$/.test(p)), [], 'types and source maps pruned');
    assert.ok(archivedTree.includes('node_modules/fastify/index.js'), 'runtime files kept');
  });
});

test('POSIX targets deploy straight into server/ without materializing', async () => {
  await fixture(async (root) => {
    let deploy;
    const run = async (args) => {
      const git = gitReply(args);
      if (git) return git;
      if (args.includes('deploy')) {
        deploy = args;
        const server = args.at(-1);
        await mkdir(server);
        await writeFile(join(server, 'package.json'), JSON.stringify({ version: '1.2.3' }));
      } else if (args[0] === 'tar') await writeFile(args[2], 'tar bytes');
      return { stdout: '', stderr: '' };
    };
    await packageServer({ root, run, outputDir: join(root, 'out'), target: 'linux-x64', expectedVersion: '1.2.3', commit: 'a'.repeat(40) });
    assert.ok(!deploy.includes('--config.node-linker=hoisted'));
  });
});

test('win32-x64 refuses any remaining link and any path too long for MAX_PATH', async () => {
  for (const [variant, pattern] of [[{ extraLink: true }, /link/i], [{ longPath: true }, /path/i]]) {
    await fixture(async (root) => {
      const run = async (args) => {
        const git = gitReply(args);
        if (git) return git;
        if (args.includes('deploy')) await hoistedDeploy(args.at(-1), variant);
        else if (args[0] === 'zip') throw new Error('must not archive a rejected tree');
        return { stdout: '', stderr: '' };
      };
      await assert.rejects(
        packageServer({ root, run, platform: 'linux', outputDir: join(root, 'out'), target: 'win32-x64', materialize: copyTree, expectedVersion: '1.2.3', commit: 'a'.repeat(40) }),
        pattern
      );
      await assert.rejects(stat(join(root, 'out')), /ENOENT/, 'failed packaging leaves no output');
    });
  }
});

test('win32 hosts zip with the system tar.exe and invoke pnpm without relying on .cmd resolution', async () => {
  await fixture(async (root) => {
    const calls = [];
    const run = async (args, options = {}) => {
      const git = gitReply(args);
      if (git) return git;
      calls.push(args);
      if (args.includes('deploy')) await hoistedDeploy(args.at(-1));
      else if (/tar\.exe$/i.test(args[0])) await writeFile(args[args.indexOf('-f') + 1], 'zip bytes');
      return { stdout: '', stderr: '' };
    };
    await packageServer({ root, run, platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, outputDir: join(root, 'out'), target: 'win32-x64', materialize: copyTree, expectedVersion: '1.2.3', commit: 'a'.repeat(40) });
    const deploy = calls.find((args) => args.includes('deploy'));
    assert.deepEqual(deploy.slice(0, 5), ['cmd.exe', '/d', '/s', '/c', 'pnpm']);
    const archive = calls.find((args) => /tar\.exe$/i.test(args[0]));
    assert.match(archive[0], /^C:\\Windows[\\/]System32[\\/]tar\.exe$/);
    assert.ok(archive.includes('-a'), 'tar.exe -a selects zip from the .zip suffix');
  });
});

test('pnpm runs through npm_execpath when the packager is itself started by pnpm', async () => {
  await fixture(async (root) => {
    let deploy;
    const run = async (args) => {
      const git = gitReply(args);
      if (git) return git;
      if (args.includes('deploy')) { deploy = args; await hoistedDeploy(args.at(-1)); }
      else if (args[0] === 'zip') await writeFile(args.at(-2), 'zip bytes');
      return { stdout: '', stderr: '' };
    };
    const npmExecpath = '/opt/pnpm/bin/pnpm.cjs';
    await packageServer({ root, run, platform: 'linux', env: { npm_execpath: npmExecpath }, outputDir: join(root, 'out'), target: 'win32-x64', materialize: copyTree, expectedVersion: '1.2.3', commit: 'a'.repeat(40) });
    assert.deepEqual(deploy.slice(0, 2), [process.execPath, npmExecpath]);
  });
});

test('stages beside the checkout on Windows when %TEMP% is on another drive', () => {
  assert.equal(stagingBase('D:\\a\\agentbrowser\\agentbrowser', { platform: 'win32', temp: 'C:\\Users\\r\\AppData\\Local\\Temp' }), 'D:\\a\\agentbrowser');
  assert.equal(stagingBase('C:\\src\\agentbrowser', { platform: 'win32', temp: 'c:\\Temp' }), 'c:\\Temp');
  assert.equal(stagingBase('/repo', { platform: 'linux', temp: '/tmp' }), '/tmp');
});

test('build-tool failures carry the tool output when diagnostics are requested', async () => {
  await assert.rejects(
    runExecutable([process.execPath, '-e', 'console.error("ERR_PNPM_SOMETHING detail"); process.exit(1)'], { diagnostics: true }),
    /exited unsuccessfully \(1\)\nERR_PNPM_SOMETHING detail/
  );
  await assert.rejects(
    runExecutable([process.execPath, '-e', 'console.error("secret"); process.exit(1)']),
    (error) => error.message.startsWith('Executable exited unsuccessfully (1)') && !error.message.includes('secret')
  );
});
