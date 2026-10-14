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
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// GitHub-hosted runner workspaces (Windows, Linux, macOS).
const RUNNER_PREFIXES = ['D:\\a\\', '/home/runner/work/', '/Users/runner/work/'];

/**
 * Canonical form for matching: lowercase, and every separator spelling — a
 * backslash escaped to any depth (\\, \\\\, \\\\\\\\ …), JSON's
 * \\/, or a slash — folded to a single "/". One needle then covers case,
 * escaping depth and mixed separators (v1.17.0's exe held D:\\\\a\\\\…, which a
 * raw-only scan passed).
 */
export function canonical(text) {
  return text.toLowerCase().replace(/(?:\\+\/?|\/)+/g, '/');
}

function needlesFor(checkout) {
  const labels = [...RUNNER_PREFIXES];
  if (checkout) {
    // A drive-letter path is already absolute, whatever host scans it.
    const absolute = /^[A-Za-z]:[\\/]/.test(checkout) ? checkout : resolve(checkout);
    labels.push(absolute.replace(/[\\/]+$/, ''));
  }
  return labels.map((label) => {
    const key = canonical(label);
    // A drive letter must start a token: "android://a/" or "field:\\a\\"
    // canonicalize to "…d:/a/" too, and are not build paths.
    return { label, key, boundary: /^[a-z]:\//.test(key) };
  });
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

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const BREAK = 0x00; // stands in for any non-ASCII unit: never part of a needle

/**
 * canonical(), applied to bytes in one pass without building strings (shipped
 * executables are ~90 MB; giant intermediate strings crashed Node). `step`
 * 1 reads ASCII/UTF-8 bytes; step 2 reads UTF-16LE code units starting at
 * `offset` (ASCII when the high byte is 0).
 */
export function canonicalBytes(data, step = 1, offset = 0) {
  const out = Buffer.allocUnsafe(Math.ceil((data.length - offset) / step));
  let n = 0;
  let separator = false;
  for (let i = offset; i + step - 1 < data.length; i += step) {
    let c = data[i];
    if (step === 2 && data[i + 1] !== 0) c = BREAK;
    if (c === SLASH || c === BACKSLASH) {
      if (!separator) out[n++] = SLASH;
      separator = true;
      continue;
    }
    separator = false;
    out[n++] = c >= 0x41 && c <= 0x5a ? c + 32 : c;
  }
  return out.subarray(0, n);
}

/**
 * TD-BROWSER-15 6: cedar-wasm's .wasm embeds Rust panic-location paths from
 * the machine that built it (/home/runner/work/cedar/…). Exactly one file may
 * ship regardless — the Node build, pinned by version and SHA-256 in
 * scripts/cedar-wasm.json (the pruner drops the esm/ and web/ builds). Any
 * other wasm file, version or hash still fails.
 */
const CEDAR_WASM_SUFFIX = '@cedar-policy/cedar-wasm/nodejs/cedar_wasm_bg.wasm';

export async function scanShippedPaths(root, { checkout, exclude = [] } = {}) {
  const needles = needlesFor(checkout).map((needle) => ({
    ...needle,
    bytes: Buffer.from(needle.key, 'latin1'),
  }));
  const isWordByte = (c) => (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
  const occurs = (haystack, { bytes, boundary }) => {
    for (let at = haystack.indexOf(bytes); at !== -1; at = haystack.indexOf(bytes, at + 1)) {
      if (!boundary || at === 0 || !isWordByte(haystack[at - 1])) return true;
    }
    return false;
  };
  const findings = [];
  let cedarPin;
  for await (const { path, rel } of files(root, root, exclude)) {
    const data = await readFile(path);
    if (rel.endsWith(CEDAR_WASM_SUFFIX)) {
      cedarPin ??= JSON.parse(
        await readFile(new URL('./cedar-wasm.json', import.meta.url), 'utf8')
      );
      const sha = createHash('sha256').update(data).digest('hex');
      if (sha !== cedarPin.nodejsWasmSha256) {
        findings.push({ file: rel, encoding: 'pin', needle: `cedar-wasm sha256 ${sha} != pinned` });
        continue;
      }
      // The pinned build: skip the runner-path scan by agreement, not oversight.
      continue;
    }
    const seen = new Set();
    // UTF-8/ASCII, then UTF-16LE at both alignments (a string inside a
    // binary can start at an odd offset).
    for (const [encoding, step, offset] of [
      ['utf8', 1, 0],
      ['utf16le', 2, 0],
      ['utf16le', 2, 1],
    ]) {
      const haystack = canonicalBytes(data, step, offset);
      for (const needle of needles) {
        if (!seen.has(needle.label) && occurs(haystack, needle)) {
          seen.add(needle.label);
          findings.push({ file: rel, encoding, needle: needle.label });
        }
      }
    }
  }
  return findings;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      checkout: { type: 'string' },
      exclude: { type: 'string', multiple: true, default: [] },
    },
  });
  const [root] = positionals;
  if (!root) {
    console.error('usage: check-shipped-paths.mjs <dir> [--checkout <path>] [--exclude <dir>]...');
    process.exit(2);
  }
  const findings = await scanShippedPaths(resolve(root), {
    checkout: values.checkout,
    exclude: values.exclude,
  });
  if (findings.length > 0) {
    for (const f of findings)
      console.error(`shipped path: ${f.file} embeds ${JSON.stringify(f.needle)} (${f.encoding})`);
    console.error(
      'shipped paths: FAIL - build-machine paths would break the artifact anywhere but the build host'
    );
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ shippedPaths: 'PASS', root: resolve(root) }));
  }
}
