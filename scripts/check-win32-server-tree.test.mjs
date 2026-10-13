import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCommand, findLinks } from './check-win32-server-tree.mjs';

test('findLinks reports nested file and directory links, and nothing for a clean tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win32-links-'));
  try {
    await mkdir(join(root, 'node_modules/a/lib'), { recursive: true });
    await writeFile(join(root, 'node_modules/a/lib/index.js'), '');
    assert.deepEqual(await findLinks(root), []);
    await symlink('lib', join(root, 'node_modules/a/alias'), 'dir');
    await symlink('index.js', join(root, 'node_modules/a/lib/file-link'));
    assert.deepEqual((await findLinks(root)).sort(), ['node_modules/a/alias', 'node_modules/a/lib/file-link']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extractCommand uses the system tar.exe on Windows and unzip elsewhere', () => {
  assert.deepEqual(extractCommand('a.zip', 'out', { platform: 'win32', env: { SystemRoot: 'D:\\Win' } }),
    [join('D:\\Win', 'System32', 'tar.exe'), '-x', '-f', 'a.zip', '-C', 'out']);
  assert.deepEqual(extractCommand('a.zip', 'out', { platform: 'linux', env: {} }), ['unzip', '-q', 'a.zip', '-d', 'out']);
});
