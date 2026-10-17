/** Private, disposable client-side captures. Never contains credentials/configuration. */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, unlink } from 'node:fs/promises';
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
      if (
        stat?.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        (process.platform === 'win32' || stat.uid === process.getuid?.())
      )
        files.push({ path, stat });
    }
    files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.path.localeCompare(b.path));
    let bytes = files.reduce((sum, file) => sum + file.stat.size, 0);
    let count = files.length;
    let removed = 0;
    const reserve = options.reserveBytes ?? 0;
    for (const file of files) {
      if (
        !options.all &&
        now - file.stat.mtimeMs < limits.maxAgeMs &&
        bytes + reserve <= limits.maxBytes &&
        count + (reserve > 0 ? 1 : 0) <= limits.maxFiles
      )
        continue;
      // Recheck identity after enumeration; a replacement is not ours to remove.
      const current = await lstat(file.path).catch(() => undefined);
      if (
        !current?.isFile() ||
        current.nlink !== 1 ||
        current.dev !== file.stat.dev ||
        current.ino !== file.stat.ino
      )
        continue;
      await unlink(file.path);
      bytes -= file.stat.size;
      count--;
      removed++;
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
    return {
      path,
      bytes: bytes.byteLength,
      expiresAt: (options.now ?? Date.now()) + limits.maxAgeMs,
    };
  } catch {
    throw new ArtifactCacheError();
  }
}
