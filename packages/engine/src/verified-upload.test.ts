import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readVerifiedUpload } from './verified-upload.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

let dir: string;
let path: string;
const bytes = Buffer.from([0, 255, 128, 10, 65]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verified-upload-'));
  path = join(dir, 'PRIVATE-RESUME.pdf');
  await writeFile(path, bytes);
});
afterEach(async () => {
  vi.clearAllMocks();
  await rm(dir, { recursive: true, force: true });
});

it('returns the exact hashed bytes detached from later file changes', async () => {
  const upload = await readVerifiedUpload(path, sha256, 'application/pdf');
  await writeFile(path, 'later replacement');
  expect(upload).toEqual({
    name: 'PRIVATE-RESUME.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
    sha256,
  });
  expect(createHash('sha256').update(upload.buffer).digest('hex')).toBe(upload.sha256);
});

it('uses neutral MIME metadata by default, including for an empty file', async () => {
  await writeFile(path, '');
  const emptySha = createHash('sha256').update('').digest('hex');
  const upload = await readVerifiedUpload(path, emptySha);
  expect(upload).toMatchObject({ mimeType: 'application/octet-stream', sha256: emptySha });
  expect(upload.buffer.length).toBe(0);
});

it('rejects an existing relative path instead of depending on the server working directory', async () => {
  await expect(readVerifiedUpload(relative(process.cwd(), path), sha256)).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  });
  expect(open).not.toHaveBeenCalled();
});

it.each(['mismatch', 'missing', 'directory', 'symlink', 'oversize'])(
  'refuses %s using sanitized static diagnostics',
  async (scenario) => {
    let target = path;
    if (scenario === 'missing') target = join(dir, 'PRIVATE-MISSING');
    if (scenario === 'directory') target = dir;
    if (scenario === 'symlink') {
      target = join(dir, 'PRIVATE-LINK');
      await symlink(path, target);
    }
    if (scenario === 'oversize') await truncate(path, 16 * 1024 * 1024 + 1);
    const caught = await readVerifiedUpload(
      target,
      scenario === 'mismatch' ? '0'.repeat(64) : sha256
    ).catch((error) => error);
    expect(caught).toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
    expect(caught.message).not.toContain('PRIVATE');
    expect(caught.message).not.toContain(dir);
  }
);

it.skipIf(process.platform === 'win32')(
  'refuses a FIFO without opening or waiting for a writer',
  async () => {
    const fifo = join(dir, 'pipe');
    await promisify(execFile)('mkfifo', [fifo]);
    await expect(readVerifiedUpload(fifo, sha256)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(open).not.toHaveBeenCalled();
  }
);

it.each([
  ['', sha256, undefined],
  [null, sha256, undefined],
  ['unused', '0'.repeat(63), undefined],
  ['unused', 'A'.repeat(64), undefined],
  ['unused', `${sha256}\n`, undefined],
  ['unused', sha256, 'application/pdf\nprivate'],
  ['unused', sha256, 'application/pdf\n'],
  ['unused', sha256, 'a'.repeat(128)],
])('validates direct helper arguments before filesystem reads', async (file, hash, mime) => {
  await expect(
    readVerifiedUpload(file === 'unused' ? path : (file as string), hash as string, mime)
  ).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  });
  expect(open).not.toHaveBeenCalled();
});

it('refuses a file replaced between lstat and open even with identical bytes', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const replacement = join(dir, 'replacement');
    await writeFile(replacement, bytes);
    await rename(replacement, path);
    return actual.open(...args);
  });
  await expect(readVerifiedUpload(path, sha256)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});

it('refuses truncation during bounded reading instead of accepting incomplete bytes', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    const read = handle.read.bind(handle);
    handle.read = vi.fn(async (buffer, offset, length, position) => {
      const result = await read(buffer, offset, length, position);
      await truncate(path, 0);
      return result;
    }) as typeof handle.read;
    return handle;
  });
  await expect(readVerifiedUpload(path, sha256)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});

it('accepts the exact 16 MiB boundary using its checked detached bytes', async () => {
  await truncate(path, 16 * 1024 * 1024);
  const content = Buffer.alloc(16 * 1024 * 1024);
  bytes.copy(content);
  const digest = createHash('sha256').update(content).digest('hex');
  const upload = await readVerifiedUpload(path, digest);
  expect(upload.buffer.length).toBe(content.length);
  expect(createHash('sha256').update(upload.buffer).digest('hex')).toBe(digest);
  expect(upload.sha256).toBe(digest);
});

it.skipIf(process.platform === 'win32')(
  'refuses a FIFO swapped in after lstat without blocking',
  async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await rm(path);
      await promisify(execFile)('mkfifo', [path]);
      return actual.open(...args);
    });
    await expect(readVerifiedUpload(path, sha256)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  }
);

it('refuses a symlink swapped in after lstat', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const original = join(dir, 'original');
    await rename(path, original);
    await symlink(original, path);
    return actual.open(...args);
  });
  await expect(readVerifiedUpload(path, sha256)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
