#!/usr/bin/env node
/**
 * Fail if a shipped file embeds a build-machine path.
 *
 * v1.17.0's Windows server exe carried `D:\a\agentbrowser\...` (the GitHub
 * runner checkout): Bun froze Playwright's __dirname lookups at compile time,
 * so the exe worked in CI and nowhere else. This scans every file of a bundle
 * for runner prefixes and the current checkout path — raw and as escaped
 * inside a JS string literal — in UTF-8 and UTF-16LE (Windows binaries
 * store paths as UTF-16). The pinned Node runtime is
 * excluded: it is an official build verified by checksum instead.
 *
 *   node scripts/check-shipped-paths.mjs <dir> [--checkout <path>] [--exclude <top-level dir>]...
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// GitHub-hosted runner workspaces (Windows, Linux, macOS).
const RUNNER_PREFIXES = ['D:\\a\\', 'D:/a/', '/home/runner/work/', '/Users/runner/work/'];

function needlesFor(checkout) {
  const needles = [...RUNNER_PREFIXES];
  if (checkout) {
    // A drive-letter path is already absolute, whatever host scans it.
    const absolute = /^[A-Za-z]:[\\/]/.test(checkout) ? checkout : resolve(checkout);
    const forward = absolute.replace(/\\/g, '/').replace(/\/$/, '');
    needles.push(forward, forward.replace(/\//g, '\\'));
  }
  // Bundlers embed paths inside JS string literals, where each backslash is
  // escaped: v1.17.0's exe holds `D:\\a\\agentbrowser`, not `D:\a\agentbrowser`.
  const escaped = needles.filter((n) => n.includes('\\')).map((n) => n.replace(/\\/g, '\\\\'));
  return [...new Set([...needles, ...escaped])];
}

async function* files(dir, top, exclude) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(top, path).split('\\').join('/');
    if (exclude.includes(rel)) continue;
    if (entry.isDirectory()) yield* files(path, top, exclude);
    else if (entry.isFile()) yield { path, rel };
  }
}

export async function scanShippedPaths(root, { checkout, exclude = [] } = {}) {
  const needles = needlesFor(checkout).flatMap((needle) => [
    { needle, encoding: 'utf8', bytes: Buffer.from(needle, 'utf8') },
    { needle, encoding: 'utf16le', bytes: Buffer.from(needle, 'utf16le') },
  ]);
  const findings = [];
  for await (const { path, rel } of files(root, root, exclude)) {
    const data = await readFile(path);
    for (const { needle, encoding, bytes } of needles) {
      if (data.includes(bytes)) findings.push({ file: rel, encoding, needle });
    }
  }
  // One finding per file and needle text is enough to act on.
  const seen = new Set();
  return findings.filter((f) => !seen.has(`${f.file}\0${f.needle}`) && seen.add(`${f.file}\0${f.needle}`));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { checkout: { type: 'string' }, exclude: { type: 'string', multiple: true, default: [] } },
  });
  const [root] = positionals;
  if (!root) {
    console.error('usage: check-shipped-paths.mjs <dir> [--checkout <path>] [--exclude <dir>]...');
    process.exit(2);
  }
  const findings = await scanShippedPaths(resolve(root), { checkout: values.checkout, exclude: values.exclude });
  if (findings.length > 0) {
    for (const f of findings) console.error(`shipped path: ${f.file} embeds ${JSON.stringify(f.needle)} (${f.encoding})`);
    console.error('shipped paths: FAIL - build-machine paths would break the artifact anywhere but the build host');
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ shippedPaths: 'PASS', root: resolve(root) }));
  }
}
