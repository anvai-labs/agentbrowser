#!/usr/bin/env node
/**
 * Download the pinned Obscura release into .cache/obscura/ with SHA-256
 * verification. Idempotent: an existing verified cache is reused.
 *
 * Env overrides:
 *   OBSCURA_VERSION  release tag (default: pinned v0.2.1)
 *   OBSCURA_BIN      path to an existing obscura binary (skips download)
 *
 * Prints the binary path on stdout for consumption by CI / launcher.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync, createWriteStream, chmodSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const CHECKSUMS = JSON.parse(
  await fs.readFile(path.join(scriptDir, 'checksums.json'), 'utf8')
);

const VERSION = process.env.OBSCURA_VERSION ?? 'v0.2.1';

const TARGETS = {
  darwin: { arm64: 'darwin-arm64', x64: 'darwin-x64' },
  linux: { arm64: 'linux-arm64', x64: 'linux-x64' },
  win32: { x64: 'win32-x64' },
};

function targetKey() {
  const platform = TARGETS[process.platform];
  if (platform === undefined) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
  const key = platform[process.arch];
  if (key === undefined) {
    throw new Error(`Unsupported arch ${process.arch} on ${process.platform}`);
  }
  return key;
}

async function sha256(file) {
  // Whole-file hash: streaming a Transform as pipeline's final stage
  // never settles (unconsumed readable side).
  const buffer = await fs.readFile(file);
  return createHash('sha256').update(buffer).digest('hex');
}

const cacheRoot = path.join(scriptDir, '..', '..', '..', '.cache', 'obscura');
const binName = process.platform === 'win32' ? 'obscura.exe' : 'obscura';

async function main() {
  if (process.env.OBSCURA_BIN) {
    if (!existsSync(process.env.OBSCURA_BIN)) {
      throw new Error(`OBSCURA_BIN points at a missing file: ${process.env.OBSCURA_BIN}`);
    }
    return process.env.OBSCURA_BIN;
  }

  const entry = CHECKSUMS[VERSION]?.[targetKey()];
  if (entry === undefined) {
    throw new Error(`No checksum entry for ${VERSION} / ${targetKey()}. Update checksums.json.`);
  }

  mkdirSync(cacheRoot, { recursive: true });
  const versionDir = path.join(cacheRoot, VERSION);
  const binPath = path.join(versionDir, binName);

  if (existsSync(binPath)) {
    const actual = await sha256(path.join(versionDir, entry.file));
    if (actual === entry.sha256) {
      return binPath;
    }
    console.warn('cache digest mismatch; re-downloading');
    await fs.rm(versionDir, { recursive: true, force: true });
  }

  const url = `https://github.com/h4ckf0r0day/obscura/releases/download/${VERSION}/${entry.file}`;
  console.error(`downloading ${url}`);
  mkdirSync(versionDir, { recursive: true });
  const archivePath = path.join(versionDir, entry.file);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(archivePath));

  const actual = await sha256(archivePath);
  if (actual !== entry.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${entry.file}: expected ${entry.sha256}, got ${actual}`
    );
  }
  console.error(`sha256 verified: ${actual}`);

  // Extract (tar.gz or zip). Archives contain obscura + obscura-worker
  // side by side; both must land in versionDir.
  if (entry.file.endsWith('.tar.gz')) {
    const tar = spawnSync('tar', ['-xzf', archivePath, '-C', versionDir], { stdio: 'inherit' });
    if (tar.status !== 0) throw new Error('tar extraction failed');
  } else {
    const unzip = spawnSync('unzip', ['-o', archivePath, '-d', versionDir], { stdio: 'inherit' });
    if (unzip.status !== 0) throw new Error('unzip extraction failed');
  }

  if (!existsSync(binPath)) {
    throw new Error(`binary ${binName} not found in archive`);
  }
  chmodSync(binPath, 0o755);
  return binPath;
}

main()
  .then((result) => {
    if (result !== undefined) {
      // Do NOT process.exit here: stdout to a pipe is async and exit
      // truncates it. Node exits naturally once the write drains.
      process.stdout.write(result + String.fromCharCode(10));
    }
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
