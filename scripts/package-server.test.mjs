import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packageServer } from './package-server.mjs';

const gitReply = (args, dirty = false) => args[0] === 'git'
  ? { stdout: args[3] === 'rev-parse' ? 'a'.repeat(40) : dirty ? ' M changed-source.ts\n' : '', stderr: '' }
  : undefined;

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
