/** Private, disposable client-side captures. Never contains credentials/configuration. */
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ArtifactRef } from '@agentbrowser/protocol';
import { writePrivateFile } from './private-file.js';

export const ARTIFACT_CACHE_LIMITS = Object.freeze({
  maxBytes: 128 * 1024 * 1024,
  maxFiles: 100,
  maxAgeMs: 24 * 60 * 60 * 1000,
});
const managed = /^capture-[0-9a-f-]{36}\.(png|jpg|webp|pdf|html|json|bin)$/;
const extensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/html': 'html',
  'application/json': 'json',
};
export interface LocalArtifactFile {
  path: string;
  bytes: number;
  expiresAt: number;
}
export interface ArtifactCacheOptions {
  directory?: string | undefined;
  now?: number;
  limits?: typeof ARTIFACT_CACHE_LIMITS;
}
export class ArtifactCacheError extends Error {
  constructor() {
    super(
      'Cannot use the private artifact cache. Choose a private AGENTBROWSER_ARTIFACT_DIR or an explicit --out file; no content was printed.'
    );
  }
}
export function artifactDirectory(directory?: string): string {
  return resolve(
    directory ?? process.env.AGENTBROWSER_ARTIFACT_DIR ?? join(homedir(), '.abrowser', 'artifacts')
  );
}
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  )
    throw new ArtifactCacheError();
}
/** Whitelist receipt fields: signed URLs, filenames and embedded payloads never escape by accident. */
export function artifactReference(artifact: ArtifactRef): ArtifactRef {
  return {
    ...(artifact.warnings ? { warnings: artifact.warnings } : {}),
    artifactId: artifact.artifactId,
    type: artifact.type,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes,
    ...(artifact.createdAt !== undefined ? { createdAt: artifact.createdAt } : {}),
    ...(artifact.expiresAt !== undefined ? { expiresAt: artifact.expiresAt } : {}),
  };
}

const identityFields = ['dev', 'ino', 'birthtimeMs', 'mtimeMs', 'size'] as const;
function sameFile(stat: Stats, identity: Record<string, unknown>): boolean {
  return identityFields.every((key) => stat[key] === identity[key]);
}
function ownedRegular(stat: Stats | undefined): stat is Stats {
  return (
    !!stat?.isFile() &&
    stat.nlink === 1 &&
    (process.platform === 'win32' || stat.uid === process.getuid?.())
  );
}
const ownershipPath = (path: string) => `${path}.managed.json`;
/** A filename is not ownership. Bounded, private records authorize cleanup only of the
 * original, unchanged file. User-created matching names and replacements are preserved.
 */
async function ownership(path: string, stat: Stats) {
  const recordPath = ownershipPath(path);
  const before = await lstat(recordPath).catch(() => undefined);
  if (
    !ownedRegular(before) ||
    before.size > 512 ||
    (process.platform !== 'win32' && (before.mode & 0o077) !== 0)
  )
    return;
  try {
    const handle = await open(recordPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!ownedRegular(opened) || !sameFile(opened, before as unknown as Record<string, unknown>))
        return;
      const buffer = Buffer.alloc(513);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 512) return;
      const record: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (typeof record !== 'object' || record === null) return;
      const data = record as Record<string, unknown>;
      if (
        data.version !== 1 ||
        typeof data.createdAt !== 'number' ||
        !Number.isFinite(data.createdAt) ||
        !sameFile(stat, data)
      )
        return;
      return { recordPath, recordStat: opened, createdAt: data.createdAt };
    } finally {
      await handle.close();
    }
  } catch {
    return;
  } // A missing, corrupt or replaced proof never authorizes deletion.
}
async function removeIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Only managed regular files directly inside the cache are eligible. Never recurse or follow links.
 * Limits are best-effort across concurrent processes; --out files are never managed or pruned.
 */
export async function pruneArtifactCache(
  options: ArtifactCacheOptions & { all?: boolean; reserveBytes?: number } = {}
) {
  const directory = artifactDirectory(options.directory);
  const now = options.now ?? Date.now();
  const limits = options.limits ?? ARTIFACT_CACHE_LIMITS;
  try {
    await privateDirectory(directory);
    const files = [];
    for (const name of await readdir(directory)) {
      if (!managed.test(name)) continue;
      const path = join(directory, name);
      const stat = await lstat(path).catch(() => undefined);
      if (!ownedRegular(stat)) continue;
      const proof = await ownership(path, stat);
      if (proof) files.push({ path, stat, ...proof });
    }
    files.sort((a, b) => a.createdAt - b.createdAt || a.path.localeCompare(b.path));
    let bytes = files.reduce((sum, file) => sum + file.stat.size, 0);
    let count = files.length;
    let removed = 0;
    const reserve = options.reserveBytes ?? 0;
    for (const file of files) {
      if (
        !options.all &&
        now - file.createdAt < limits.maxAgeMs &&
        bytes + reserve <= limits.maxBytes &&
        count + (reserve > 0 ? 1 : 0) <= limits.maxFiles
      )
        continue;
      // Both data and ownership record must still be the entries we inspected.
      const current = await lstat(file.path).catch(() => undefined);
      const currentRecord = await lstat(file.recordPath).catch(() => undefined);
      if (
        !ownedRegular(current) ||
        !ownedRegular(currentRecord) ||
        !sameFile(current, file.stat as unknown as Record<string, unknown>) ||
        !sameFile(currentRecord, file.recordStat as unknown as Record<string, unknown>)
      )
        continue;
      const deleted = await removeIfPresent(file.path);
      const finalRecord = await lstat(file.recordPath).catch(() => undefined);
      if (
        ownedRegular(finalRecord) &&
        sameFile(finalRecord, file.recordStat as unknown as Record<string, unknown>)
      )
        await removeIfPresent(file.recordPath);
      bytes -= file.stat.size;
      count--;
      if (deleted) removed++;
    }
    return { directory, removed, files: count, bytes };
  } catch {
    throw new ArtifactCacheError();
  }
}
export async function cacheLocalArtifact(
  bytes: Uint8Array,
  contentType: string,
  options: ArtifactCacheOptions = {}
): Promise<LocalArtifactFile> {
  const directory = artifactDirectory(options.directory);
  const limits = options.limits ?? ARTIFACT_CACHE_LIMITS;
  if (bytes.byteLength > limits.maxBytes) throw new ArtifactCacheError();
  try {
    await pruneArtifactCache({
      ...options,
      directory,
      reserveBytes: Math.max(1, bytes.byteLength),
    });
    const extension = extensions[contentType.split(';')[0]?.trim().toLowerCase() ?? ''] ?? 'bin';
    const path = join(directory, `capture-${randomUUID()}.${extension}`);
    await writePrivateFile(path, bytes);
    const stat = await lstat(path);
    const createdAt = options.now ?? Date.now();
    await writePrivateFile(
      ownershipPath(path),
      JSON.stringify({
        version: 1,
        createdAt,
        ...Object.fromEntries(identityFields.map((key) => [key, stat[key]])),
      })
    );
    return {
      path,
      bytes: bytes.byteLength,
      expiresAt: createdAt + limits.maxAgeMs,
    };
  } catch {
    throw new ArtifactCacheError();
  }
}
