/** Private byte links for the standalone recipe; not a verdict evaluator or attestation. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const MAX_BYTES = 64 * 1024;
const invalid = () => new Error('Private recipe artifacts are invalid.');
const decode = (bytes) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

function checkPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096) throw invalid();
}

/** Owner-supplied path only. Bound reads even if a regular file grows after stat. */
export async function readPrivateRecipeBytes(path) {
  let handle;
  try {
    checkPath(path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw invalid();
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.ino !== before.ino || metadata.dev !== before.dev ||
        metadata.size < 2 || metadata.size > MAX_BYTES ||
        (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)) throw invalid();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size < 2 || size > MAX_BYTES) throw invalid();
    return buffer.subarray(0, size);
  } catch { throw invalid(); }
  finally {
    try { await handle?.close(); } catch { throw invalid(); }
  }
}

/** Attempt every owned cleanup even if one file is locked; never expose filesystem errors. */
export async function cleanupRecipeFiles(paths, { remove = rm } = {}) {
  const results = await Promise.allSettled(paths.map(async (path) => remove(path, { force: true })));
  if (results.some((result) => result.status === 'rejected')) throw invalid();
}

function describe(path, bytes, oracleMatches) {
  if (typeof oracleMatches !== 'boolean') throw invalid();
  return {
    schemaVersion: 1,
    provenance: 'caller_observed',
    evaluation: {
      href: encodeURIComponent(basename(path)),
      mediaType: 'application/json',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    oracleMatches,
  };
}

/** Publish after lifecycle settlement; a digest binds bytes, never case truth. */
export async function publishRecipeArtifacts(path, { evaluation, oracleMatches }, { signal } = {}) {
  const owned = [];
  try {
    checkPath(path);
    signal?.throwIfAborted();
    if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) throw invalid();
    const serialized = JSON.stringify(evaluation);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) + 1 > MAX_BYTES) throw invalid();
    const bytes = Buffer.from(`${serialized}\n`);
    const snapshot = decode(bytes);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw invalid();
    const manifest = describe(path, bytes, oracleMatches);
    for (const [target, content] of [
      [path, bytes],
      [`${path}.manifest.json`, Buffer.from(`${JSON.stringify(manifest)}\n`)],
    ]) {
      signal?.throwIfAborted();
      const handle = await open(target, 'wx', 0o600);
      owned.push(target);
      try { await handle.writeFile(content, { signal }); }
      finally { await handle.close(); }
      signal?.throwIfAborted();
    }
    return manifest;
  } catch {
    // Never unlink a pre-existing output when exclusive creation failed.
    await cleanupRecipeFiles(owned.reverse());
    throw invalid();
  }
}

/** Read only derived local paths, then compare the manifest to the actual report bytes. */
export async function readRecipeArtifacts(path) {
  try {
    const bytes = await readPrivateRecipeBytes(path);
    const manifest = decode(await readPrivateRecipeBytes(`${path}.manifest.json`));
    const expected = describe(path, bytes, manifest?.oracleMatches);
    if (!isDeepStrictEqual(manifest, expected)) throw invalid();
    const evaluation = decode(bytes);
    if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) throw invalid();
    return { evaluation, manifest };
  } catch { throw invalid(); }
}
