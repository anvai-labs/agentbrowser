import { randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ARTIFACT_CACHE_LIMITS,
  artifactReference,
  cacheLocalArtifact,
  pruneArtifactCache,
} from './local-artifacts.js';

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'ab-artifacts-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
describe('private artifact cache', () => {
  it('stores exact binary bytes in unique private files without putting payloads or signed URLs in receipts', async () => {
    const dir = await directory();
    const bytes = Buffer.from([0, 255, 128, 10, 13, 1]);
    const files = await Promise.all(
      Array.from({ length: 4 }, () => cacheLocalArtifact(bytes, 'image/png', { directory: dir }))
    );
    expect(new Set(files.map((file) => file.path)).size).toBe(4);
    for (const file of files) {
      expect((await readFile(file.path)).equals(bytes)).toBe(true);
      if (process.platform !== 'win32') expect((await lstat(file.path)).mode & 0o777).toBe(0o600);
    }
    const receipt = artifactReference({
      artifactId: 'a',
      type: 'screenshot',
      contentType: 'image/png',
      sizeBytes: 6,
      url: '/?token=synthetic',
      inline: { contentBase64: bytes.toString('base64'), byteSize: 6 },
    });
    expect(receipt).not.toHaveProperty('url');
    expect(receipt).not.toHaveProperty('inline');
  });
  it.skipIf(process.platform === 'win32')(
    'evicts expired and oldest excess managed files while preserving user files and links',
    async () => {
      const dir = await directory();
      const expired = await cacheLocalArtifact(Buffer.alloc(4), 'image/png', {
        directory: dir,
        now: 1,
      });
      const keep = join(dir, 'user-output.png');
      await writeFile(keep, 'user');
      const symbolic = join(dir, `capture-${randomUUID()}.png`);
      const hard = join(dir, `capture-${randomUUID()}.png`);
      await symlink(keep, symbolic);
      await link(keep, hard);
      const limits = { ...ARTIFACT_CACHE_LIMITS, maxBytes: 6, maxFiles: 1 };
      const first = await cacheLocalArtifact(Buffer.alloc(4, 1), 'image/png', {
        directory: dir,
        limits,
      });
      expect(await readdir(dir)).not.toContain(expired.path.split('/').at(-1));
      const second = await cacheLocalArtifact(Buffer.alloc(4, 2), 'image/png', {
        directory: dir,
        limits,
      });
      await expect(lstat(first.path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readFile(second.path))[0]).toBe(2);
      expect((await pruneArtifactCache({ directory: dir, all: true })).removed).toBe(1);
      expect(await readFile(keep, 'utf8')).toBe('user');
      expect((await lstat(symbolic)).isSymbolicLink()).toBe(true);
      expect((await lstat(hard)).nlink).toBe(2);
    }
  );
  it.skipIf(process.platform === 'win32')(
    'fails closed on a symlink cache or oversized content',
    async () => {
      const dir = await directory();
      const target = await directory();
      const alias = join(dir, 'alias');
      await symlink(target, alias, 'dir');
      await expect(
        cacheLocalArtifact(Buffer.from('sensitive fixture'), 'text/html', { directory: alias })
      ).rejects.toThrow('no content was printed');
      await expect(
        cacheLocalArtifact(Buffer.alloc(8), 'image/png', {
          directory: target,
          limits: { ...ARTIFACT_CACHE_LIMITS, maxBytes: 4 },
        })
      ).rejects.toThrow('no content was printed');
      expect(await readdir(target)).toEqual([]);
    }
  );
  it.skipIf(process.platform === 'win32')('rejects a cache readable by other users', async () => {
    const dir = await directory();
    await chmod(dir, 0o755);
    await expect(
      cacheLocalArtifact(Buffer.from('private'), 'text/html', { directory: dir })
    ).rejects.toThrow('private artifact cache');
    expect(await readdir(dir)).toEqual([]);
  });
});

it('preserves matching user filenames, replacements and corrupt ownership records', async () => {
  const dir = await directory();
  const userFile = join(dir, `capture-${randomUUID()}.png`);
  await writeFile(userFile, 'explicit output');
  const replaced = await cacheLocalArtifact(Buffer.from('original'), 'image/png', {
    directory: dir,
  });
  await rm(replaced.path);
  await writeFile(replaced.path, 'user replacement');
  const corrupt = await cacheLocalArtifact(Buffer.from('keep'), 'image/png', { directory: dir });
  await writeFile(`${corrupt.path}.managed.json`, 'invalid');
  const oversized = await cacheLocalArtifact(Buffer.from('also keep'), 'image/png', {
    directory: dir,
  });
  await writeFile(`${oversized.path}.managed.json`, 'x'.repeat(513));
  const removable = await cacheLocalArtifact(Buffer.from('managed'), 'image/png', {
    directory: dir,
  });
  expect((await pruneArtifactCache({ directory: dir, all: true })).removed).toBe(1);
  await expect(lstat(removable.path)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(`${removable.path}.managed.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(userFile, 'utf8')).toBe('explicit output');
  expect(await readFile(replaced.path, 'utf8')).toBe('user replacement');
  expect(await readFile(corrupt.path, 'utf8')).toBe('keep');
  expect(await readFile(oversized.path, 'utf8')).toBe('also keep');
});
it('concurrent saves tolerate another pruner removing expired data and ownership records', async () => {
  const dir = await directory();
  await cacheLocalArtifact(Buffer.from('expired'), 'image/png', { directory: dir, now: 1 });
  const files = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      cacheLocalArtifact(Buffer.from([i]), 'image/png', { directory: dir })
    )
  );
  expect(new Set(files.map((file) => file.path)).size).toBe(8);
  for (let i = 0; i < files.length; i++) expect((await readFile(files[i]!.path))[0]).toBe(i);
  expect((await pruneArtifactCache({ directory: dir, all: true })).removed).toBe(8);
  expect(await readdir(dir)).toEqual([]);
});
