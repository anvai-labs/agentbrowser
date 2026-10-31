#!/usr/bin/env node
/**
 * Fetch the pinned official Node.js runtime for the Windows bundle.
 *
 * The bundle runs the server on its own Node (scripts/windows-node.json, kept
 * equal to .tool-versions), never on whatever node.exe a user may have. Both
 * the archive and node.exe are checked against SHA-256 values pinned from
 * nodejs.org's SHASUMS256.txt; node.exe ships unmodified (it keeps its
 * OpenJS Foundation signature) with its LICENSE, and nothing else.
 *
 *   node scripts/fetch-windows-node.mjs --destination <bundle>/node
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runExecutable } from './release-smoke.mjs';

const PIN = new URL('./windows-node.json', import.meta.url);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export async function readNodePin() {
  return JSON.parse(await readFile(PIN, 'utf8'));
}

async function download(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(300_000) });
  assert.ok(response.ok, `Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function extract(zip, into, { platform = process.platform, env = process.env } = {}) {
  const command =
    platform === 'win32'
      ? [join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), '-x', '-f', zip, '-C', into]
      : ['unzip', '-q', zip, '-d', into];
  await runExecutable(command, { timeoutMs: 300_000, diagnostics: true });
}

export async function fetchWindowsNode({
  destination,
  pin,
  download: get = download,
  extract: unpack = extract,
}) {
  pin ??= await readNodePin();
  const url = new URL(pin.zip.url);
  assert.ok(
    url.protocol === 'https:' && url.hostname === 'nodejs.org',
    `Node must come from https://nodejs.org (got ${pin.zip.url})`
  );
  const work = await mkdtemp(join(tmpdir(), 'agentbrowser-node-'));
  try {
    const archive = await get(pin.zip.url);
    assert.equal(
      sha256(archive),
      pin.zip.sha256,
      `Node archive checksum mismatch for ${pin.zip.url}`
    );
    const zip = join(work, 'node.zip');
    await writeFile(zip, archive);
    await unpack(zip, work);
    const top = join(work, `node-v${pin.version}-win-x64`);
    const exe = await readFile(join(top, 'node.exe'));
    assert.equal(sha256(exe), pin.nodeExeSha256, 'node.exe checksum mismatch');
    await mkdir(destination, { recursive: true });
    await copyFile(join(top, 'node.exe'), join(destination, 'node.exe'));
    await copyFile(join(top, 'LICENSE'), join(destination, 'LICENSE'));
    return { version: pin.version, nodeExeSha256: pin.nodeExeSha256 };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { destination: { type: 'string' } } });
    assert.ok(values.destination, '--destination is required');
    console.log(
      JSON.stringify(await fetchWindowsNode({ destination: resolve(values.destination) }))
    );
  } catch (error) {
    console.error(`windows node: FAIL - ${error.message}`);
    process.exitCode = 1;
  }
}
