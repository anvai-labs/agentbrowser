import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, canonicalBytes, scanShippedPaths } from './check-shipped-paths.mjs';
import { fetchWindowsNode, readNodePin } from './fetch-windows-node.mjs';

async function withDir(exercise) {
  const dir = await mkdtemp(join(tmpdir(), 'win-bundle-tools-'));
  try { await exercise(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// --- pinned Node runtime ---

test('the Windows Node pin tracks .tool-versions and nodejs.org naming', async () => {
  const pin = await readNodePin();
  const toolVersions = await readFile(new URL('../.tool-versions', import.meta.url), 'utf8');
  assert.equal(pin.version, toolVersions.match(/^nodejs\s+(\S+)/m)[1], 'bundle the runtime the repo is built and tested on');
  assert.equal(pin.zip.url, `https://nodejs.org/dist/v${pin.version}/node-v${pin.version}-win-x64.zip`);
  assert.match(pin.zip.sha256, /^[a-f0-9]{64}$/);
  assert.match(pin.nodeExeSha256, /^[a-f0-9]{64}$/);
});

function fakePin(zipBytes, exeBytes) {
  return { version: '9.9.9', zip: { url: 'https://nodejs.org/dist/v9.9.9/node-v9.9.9-win-x64.zip', sha256: sha256(zipBytes) }, nodeExeSha256: sha256(exeBytes) };
}

test('fetchWindowsNode verifies the archive and node.exe, and installs only node.exe and LICENSE', async () => {
  await withDir(async (dir) => {
    const zipBytes = Buffer.from('zip');
    const exeBytes = Buffer.from('MZ node');
    const pin = fakePin(zipBytes, exeBytes);
    const extract = async (zip, into) => {
      assert.deepEqual(await readFile(zip), zipBytes);
      const top = join(into, 'node-v9.9.9-win-x64');
      await mkdir(top, { recursive: true });
      await writeFile(join(top, 'node.exe'), exeBytes);
      await writeFile(join(top, 'LICENSE'), 'MIT');
      await writeFile(join(top, 'npm.cmd'), 'not shipped');
    };
    const destination = join(dir, 'bundle', 'node');
    const result = await fetchWindowsNode({ destination, pin, download: async () => zipBytes, extract });
    assert.deepEqual((await readFile(join(destination, 'node.exe'))), exeBytes);
    assert.equal(await readFile(join(destination, 'LICENSE'), 'utf8'), 'MIT');
    await assert.rejects(readFile(join(destination, 'npm.cmd')), /ENOENT/);
    assert.equal(result.version, '9.9.9');
  });
});

test('fetchWindowsNode refuses a tampered archive or binary and leaves nothing behind', async () => {
  await withDir(async (dir) => {
    const exeBytes = Buffer.from('MZ node');
    const pin = fakePin(Buffer.from('zip'), exeBytes);
    const destination = join(dir, 'node');
    await assert.rejects(
      fetchWindowsNode({ destination, pin, download: async () => Buffer.from('evil'), extract: async () => {} }),
      /archive checksum mismatch/
    );
    const extract = async (_zip, into) => {
      const top = join(into, 'node-v9.9.9-win-x64');
      await mkdir(top, { recursive: true });
      await writeFile(join(top, 'node.exe'), 'MZ patched');
      await writeFile(join(top, 'LICENSE'), 'MIT');
    };
    await assert.rejects(
      fetchWindowsNode({ destination, pin, download: async () => Buffer.from('zip'), extract }),
      /node\.exe checksum mismatch/
    );
    await assert.rejects(readFile(join(destination, 'node.exe')), /ENOENT/);
  });
});

test('fetchWindowsNode only downloads from nodejs.org over https', async () => {
  await withDir(async (dir) => {
    const pin = { ...fakePin(Buffer.from('z'), Buffer.from('e')), zip: { url: 'http://example.com/node.zip', sha256: '0'.repeat(64) } };
    await assert.rejects(fetchWindowsNode({ destination: join(dir, 'n'), pin, download: async () => Buffer.alloc(0), extract: async () => {} }), /nodejs\.org/);
  });
});

// --- shipped-path scan (the v1.17.0 regression gate) ---

test('scanShippedPaths finds runner and checkout paths in UTF-8 and UTF-16LE, in any file', async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, 'server', 'dist'), { recursive: true });
    await writeFile(join(dir, 'server', 'dist', 'ok.js'), 'module.exports = 1;');
    await writeFile(join(dir, 'a.exe'), Buffer.concat([Buffer.from([0, 1]), Buffer.from('D:\\a\\agentbrowser\\agentbrowser\\node_modules\\x', 'utf16le')]));
    await writeFile(join(dir, 'server', 'dist', 'bad.js'), 'require("/home/runner/work/agentbrowser/agentbrowser/x")');
    await writeFile(join(dir, 'server', 'dist', 'local.js'), 'const p = "/home/dev/src/agentbrowser/packages/api";');
    const findings = await scanShippedPaths(dir, { checkout: '/home/dev/src/agentbrowser' });
    assert.deepEqual(
      findings.map((f) => `${f.file} ${f.encoding} ${f.needle}`).sort(),
      [
        'a.exe utf16le D:\\a\\',
        'server/dist/bad.js utf8 /home/runner/work/',
        'server/dist/local.js utf8 /home/dev/src/agentbrowser',
      ]
    );
  });
});

test('scanShippedPaths skips excluded directories (the pinned Node runtime is verified by hash)', async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, 'node'), { recursive: true });
    await writeFile(join(dir, 'node', 'node.exe'), 'built at D:\\a\\ by someone else');
    assert.deepEqual(await scanShippedPaths(dir, { exclude: ['node'] }), []);
    assert.equal((await scanShippedPaths(dir)).length, 1);
  });
});

test('scanShippedPaths matches Windows checkout paths with either separator', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'x.js'), 'C:/Users/dev/agentbrowser/packages');
    assert.equal((await scanShippedPaths(dir, { checkout: 'C:\\Users\\dev\\agentbrowser' })).length, 1);
  });
});

test('scanShippedPaths catches a path escaped inside a JS string literal (the v1.17.0 exe)', async () => {
  await withDir(async (dir) => {
    // Bytes as found in v1.17.0's agentbrowser-server-windows-x64.exe.
    await writeFile(join(dir, 'server.exe'), Buffer.from('require("D:\\\\a\\\\agentbrowser\\\\agentbrowser\\\\node_modules")'));
    const findings = await scanShippedPaths(dir);
    assert.deepEqual(findings.map((f) => f.needle), ['D:\\a\\']);
  });
});

test('scanShippedPaths catches other spellings of a build path (case, double escaping, JSON, mixed separators)', async () => {
  await withDir(async (dir) => {
    const forms = {
      'lower.js': 'x = "d:\\\\a\\\\agentbrowser"', // lowercase drive, JS-escaped
      'double.js': 'x = "D:\\\\\\\\a\\\\\\\\agentbrowser"', // JSON inside JS: four backslashes
      'json.json': '{"p":"D:\\/a\\/agentbrowser"}', // JSON-escaped forward slashes
      'mixed.js': 'x = "D:\\\\a/agentbrowser"', // backslash then slash
      'lower-posix.js': 'x = "/HOME/RUNNER/WORK/agentbrowser"', // case-folded POSIX runner path
    };
    for (const [name, text] of Object.entries(forms)) await writeFile(join(dir, name), text);
    const found = new Set((await scanShippedPaths(dir)).map((f) => f.file));
    assert.deepEqual([...found].sort(), Object.keys(forms).sort());
  });
});

test('byte canonicalization agrees with the string form on ASCII and UTF-16LE', () => {
  const text = 'X D:\\\\A/agentBrowser\\/Node_Modules y';
  assert.equal(canonicalBytes(Buffer.from(text, 'latin1')).toString('latin1'), canonical(text));
  const utf16 = Buffer.concat([Buffer.from([0x41]), Buffer.from(text, 'utf16le')]);
  assert.equal(canonicalBytes(utf16, 2, 1).toString('latin1'), canonical(text));
});

test('a drive-letter needle needs a boundary: android://a/ or field:\\a\\ is not D:\\a\\', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'benign.js'), 'x = "android://a/b"; y = "cid://a/b"; z = "field:\\\\a\\\\";');
    assert.deepEqual(await scanShippedPaths(dir), []);
    await writeFile(join(dir, 'real.js'), 'p = "(D:\\\\a\\\\agentbrowser)"');
    assert.deepEqual((await scanShippedPaths(dir)).map((f) => f.file), ['real.js']);
  });
});
