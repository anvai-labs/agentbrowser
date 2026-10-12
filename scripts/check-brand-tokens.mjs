#!/usr/bin/env node
/**
 * The docs site wears the Anvai family brand. docs/stylesheets/tokens.css is a
 * VERBATIM copy of anvaiops design/tokens.css (the family's single source of
 * truth, guarded there by services/dqcp/tests/test_theme.py); brand.css (the
 * Material mapping) and the self-hosted Inter font are shared verbatim by every
 * Anvai docs site. This repo cannot read anvaiops in CI, so every shared file is
 * pinned by digest: a local edit fails here. To adopt a change, re-copy and
 * update the digests (the Python repos use scripts/check_brand_tokens.py).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CANONICAL = 'anvaiops design/tokens.css (as of e8215fc) + shared brand.css v1.1';
const PINNED = {
  'tokens.css': '2ea50eda33844d7c1ae58a264c8356b5f08841c665365f97aa61df53b175bca6',
  'brand.css': '53338f26b8d1d0f08d170bb8557f067143206ac382ae83164259d7e7ed2583cf',
  'fonts/inter-latin-wght-normal.woff2': '313809049cc15a226aaca190f5aee5f18d8125a5219eafe1cd0b52098a9b9699',
  'fonts/Inter-OFL.txt': '3b0a5fca3d17942cde889069889dedbbbd075e9b599968c82a95f4d944e9b345',
};
const REQUIRED_EXTRA_CSS = ['stylesheets/tokens.css', 'stylesheets/brand.css'];

const ROOT = resolve(process.argv[2] ?? '.');
const failures = [];

for (const [name, digest] of Object.entries(PINNED)) {
  const path = join(ROOT, 'docs/stylesheets', name);
  if (!existsSync(path)) {
    failures.push(`docs/stylesheets/${name} is missing`);
    continue;
  }
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== digest) {
    failures.push(`docs/stylesheets/${name} drifted (sha256 ${actual}); re-copy the shared file`);
  }
}

// Parse the top-level extra_css list; a comment that merely mentions a path does not count.
const mkdocs = readFileSync(join(ROOT, 'mkdocs.yml'), 'utf8');
const block = /^extra_css:[ \t]*\n((?:[ \t]+-[^\n]*\n?)+)/m.exec(mkdocs)?.[1] ?? '';
const entries = [...block.matchAll(/^[ \t]+-[ \t]*([^#\n]+)/gm)].map((m) =>
  m[1].trim().replace(/^['"]|['"]$/g, '')
);
const listed = entries.filter((entry) => REQUIRED_EXTRA_CSS.includes(entry));
if (listed.join() !== REQUIRED_EXTRA_CSS.join()) {
  failures.push(`mkdocs.yml extra_css must list ${REQUIRED_EXTRA_CSS.join(' then ')} (found ${entries.join(', ') || 'none'})`);
}
if (!/^[ \t]+primary:[ \t]*custom[ \t]*$/m.test(mkdocs)) {
  failures.push('mkdocs.yml palette must set primary: custom');
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`brand: ${failure}`);
  process.exit(1);
}
console.log(`brand tokens OK (${CANONICAL})`);
