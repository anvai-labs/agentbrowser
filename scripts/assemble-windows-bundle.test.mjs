import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleWindowsBundle } from './assemble-windows-bundle.mjs';

async function withInputs(exercise) {
  const dir = await mkdtemp(join(tmpdir(), 'assemble-'));
  try {
    for (const name of ['launcher.exe', 'cli.exe', 'mcp.exe']) await writeFile(join(dir, name), `MZ ${name}`);
    await writeFile(join(dir, 'server.zip'), 'zip');
    await exercise(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fakeNode = async ({ destination }) => {
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'node.exe'), 'MZ node');
  await writeFile(join(destination, 'LICENSE'), 'MIT');
  return { version: '24.21.0' };
};

function runner({ version = '1.2.3', extra } = {}) {
  const calls = [];
  const run = async (args, options = {}) => {
    calls.push({ args, options });
    if (args[0] === 'unzip' || /tar\.exe$/i.test(args[0]) && args.includes('-x')) {
      const into = args[0] === 'unzip' ? args.at(-1) : args.at(-1);
      await mkdir(join(into, 'server', 'dist'), { recursive: true });
      await writeFile(join(into, 'server', 'dist', 'bin.js'), 'export {};');
      await writeFile(join(into, 'server', 'VERSION.json'), JSON.stringify({ version, commit: 'a'.repeat(40) }));
      if (extra) await extra(into);
    } else if (args[0] === 'zip') {
      await writeFile(args[3], 'bundle zip');
    } else if (/tar\.exe$/i.test(args[0])) {
      await writeFile(args[args.indexOf('-f') + 1], 'bundle zip');
    }
    return { stdout: '', stderr: '' };
  };
  return { run, calls };
}

const base = (dir, run, overrides = {}) => ({
  root: dir, outputDir: join(dir, 'out'), expectedVersion: '1.2.3',
  serverZip: join(dir, 'server.zip'), launcher: join(dir, 'launcher.exe'), cli: join(dir, 'cli.exe'), mcp: join(dir, 'mcp.exe'),
  platform: 'linux', env: {}, run, fetchNode: fakeNode, ...overrides,
});

test('assembles launcher, CLI, MCP, pinned node and server tree into one flat zip', async () => {
  await withInputs(async (dir) => {
    const { run, calls } = runner();
    let entries;
    const recording = async (args, options) => {
      if (args[0] === 'zip') entries = { cwd: options.cwd, names: args.slice(4) };
      return run(args, options);
    };
    const result = await assembleWindowsBundle(base(dir, recording));
    assert.equal(result.file, join(dir, 'out', 'agentbrowser-windows-x64.zip'));
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(entries.names.sort(), ['agentbrowser-cli.exe', 'agentbrowser-mcp.exe', 'agentbrowser-server.exe', 'node', 'server']);
    assert.equal(await readFile(join(entries.cwd, 'agentbrowser-server.exe'), 'utf8').catch(() => 'cleaned'), 'cleaned', 'staging is removed');
    assert.ok(calls.some(({ args }) => args[0] === 'unzip'));
  });
});

test('refuses a server tree of another version', async () => {
  await withInputs(async (dir) => {
    await assert.rejects(assembleWindowsBundle(base(dir, runner({ version: '9.9.9' }).run)), /9\.9\.9/);
    await assert.rejects(stat(join(dir, 'out')), /ENOENT/, 'no partial output');
  });
});

test('refuses build-machine paths and links in the assembled bundle', async () => {
  await withInputs(async (dir) => {
    const leaky = runner({ extra: (into) => writeFile(join(into, 'server', 'dist', 'x.js'), `"${dir}/packages/api"`) });
    await assert.rejects(assembleWindowsBundle(base(dir, leaky.run)), /build-machine path/);
  });
  await withInputs(async (dir) => {
    const linked = runner({ extra: (into) => symlink('bin.js', join(into, 'server', 'dist', 'alias.js')) });
    await assert.rejects(assembleWindowsBundle(base(dir, linked.run)), /link/);
  });
});

test('never overwrites an existing output directory, and leaves it intact', async () => {
  await withInputs(async (dir) => {
    await mkdir(join(dir, 'out'));
    await writeFile(join(dir, 'out', 'keep.txt'), 'previous candidate');
    await assert.rejects(assembleWindowsBundle(base(dir, runner().run)), /EEXIST/);
    assert.equal(await readFile(join(dir, 'out', 'keep.txt'), 'utf8'), 'previous candidate');
  });
});

test('refuses a bundle whose paths exceed the Windows MAX_PATH budget', async () => {
  await withInputs(async (dir) => {
    const deep = runner({ extra: async (into) => {
      const long = join(into, 'server', 'node_modules', 'x'.repeat(60), 'node_modules', 'y'.repeat(60));
      await mkdir(long, { recursive: true });
      await writeFile(join(long, 'index.js'), '');
    } });
    await assert.rejects(assembleWindowsBundle(base(dir, deep.run)), /MAX_PATH/);
    await assert.rejects(stat(join(dir, 'out')), /ENOENT/);
  });
});

test('on Windows hosts, extracts and zips with the system tar.exe', async () => {
  await withInputs(async (dir) => {
    const { run, calls } = runner();
    await assembleWindowsBundle(base(dir, run, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } }));
    const tars = calls.filter(({ args }) => /tar\.exe$/i.test(args[0]));
    assert.equal(tars.length, 2);
    assert.ok(tars.some(({ args }) => args.includes('-a')), 'zip creation uses tar -a');
  });
});
