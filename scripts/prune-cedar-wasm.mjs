#!/usr/bin/env node
/**
 * TD-BROWSER-15 phase 3b/6: prune @cedar-policy/cedar-wasm to the Node build.
 *
 * The package ships three wasm builds (nodejs/, esm/, web/); the server only
 * imports '@cedar-policy/cedar-wasm/nodejs'. Pruning keeps one wasm (~4.3 MB)
 * instead of three in every prod deploy tree — the server tarball, the Docker
 * image and the Windows bundle — and the shipped-path gate pins the surviving
 * file by hash (scripts/cedar-wasm.json).
 *
 * Usage: node scripts/prune-cedar-wasm.mjs <deployed-tree-root> [...more]
 * Idempotent; exits 1 if the package exists but does not match the pinned
 * version layout (a version bump must re-pin consciously, not silently).
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const PIN_PATH = join(here, 'cedar-wasm.json');

export async function readPin() {
  return JSON.parse(await readFile(PIN_PATH, 'utf8'));
}

/** The sha256 of the one wasm file that may ship, verified against the pin. */
export async function wasmSha256(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

const DROP = ['esm', 'web'];

/**
 * Prunes every @cedar-policy/cedar-wasm under the given tree roots. Returns
 * the number of packages pruned. Throws when the installed version disagrees
 * with the pin — a silent version bump is exactly what the pin exists to
 * catch.
 */
export async function pruneCedarWasm(...roots) {
  const pin = await readPin();
  let pruned = 0;
  for (const root of roots) {
    // A prod deploy keeps pnpm's virtual store (POSIX tarball, Docker image):
    // the real files live under node_modules/.pnpm/<pkg>@<v>/node_modules/…;
    // the Windows bundle materializes a hoisted tree instead. Cover both.
    const scopes = [join(root, 'node_modules', '@cedar-policy')];
    let store;
    try {
      store = await readdir(join(root, 'node_modules', '.pnpm'), { withFileTypes: true });
    } catch {
      store = [];
    }
    for (const entry of store) {
      if (entry.isDirectory() && entry.name.startsWith('@cedar-policy+cedar-wasm@')) {
        scopes.push(join(root, 'node_modules', '.pnpm', entry.name, 'node_modules', '@cedar-policy'));
      }
    }
    for (const scope of scopes) {
      let entries;
      try {
        entries = await readdir(scope, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name !== 'cedar-wasm') continue;
        const pkg = join(scope, 'cedar-wasm');
        const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
        if (manifest.version !== pin.version) {
          throw new Error(
            `@cedar-policy/cedar-wasm ${manifest.version} is installed but scripts/cedar-wasm.json pins ${pin.version}; re-pin (and re-measure the size gates) deliberately`
          );
        }
        const sha = await wasmSha256(join(pkg, 'nodejs', 'cedar_wasm_bg.wasm'));
        if (sha !== pin.nodejsWasmSha256) {
          throw new Error(
            `@cedar-policy/cedar-wasm ${pin.version} wasm hash ${sha} does not match the pin ${pin.nodejsWasmSha256}`
          );
        }
        for (const dir of DROP) await rm(join(pkg, dir), { recursive: true, force: true });
        pruned += 1;
      }
    }
  }
  return pruned;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error('usage: node scripts/prune-cedar-wasm.mjs <deployed-tree-root> [...]');
    process.exit(2);
  }
  const pruned = await pruneCedarWasm(...roots);
  console.log(`pruned ${pruned} cedar-wasm package(s) to the nodejs build`);
}
