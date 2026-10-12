#!/usr/bin/env node
/**
 * The docs site wears the Anvai family brand: docs/stylesheets/tokens.css is a
 * VERBATIM copy of anvaiops design/tokens.css (the family's single source of
 * truth, guarded there by services/dqcp/tests/test_theme.py). This repo cannot
 * read anvaiops in CI, so the copy is pinned by digest: a local edit fails here.
 * brand.css (the Material mapping) is shared verbatim by every Anvai docs site
 * and pinned the same way. To adopt a change, re-copy and update the digests.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CANONICAL_COMMIT = 'anvai-labs/anvaiops@e8215fc design/tokens.css';
const CANONICAL_SHA256 = '2ea50eda33844d7c1ae58a264c8356b5f08841c665365f97aa61df53b175bca6';

const ROOT = resolve(process.argv[2] ?? '.');
const failures = [];

const tokens = readFileSync(join(ROOT, 'docs/stylesheets/tokens.css'));
const digest = createHash('sha256').update(tokens).digest('hex');
if (digest !== CANONICAL_SHA256) {
  failures.push(
    `docs/stylesheets/tokens.css drifted from ${CANONICAL_COMMIT} (sha256 ${digest}); re-copy the canonical file`
  );
}

const BRAND_SHA256 = '7ffe54af26dde70b8f275f3b8c833f480ee9c76dad0bfe31aa371aaad43a0402';
const FONT_SHA256 = '3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62';
const brand = readFileSync(join(ROOT, 'docs/stylesheets/brand.css'));
const brandDigest = createHash('sha256').update(brand).digest('hex');
if (brandDigest !== BRAND_SHA256) {
  failures.push(
    `docs/stylesheets/brand.css drifted from the shared family v1 file (sha256 ${brandDigest}); re-copy it`
  );
}

const font = readFileSync(join(ROOT, 'docs/stylesheets/fonts/inter-latin-wght-normal.woff2'));
if (createHash('sha256').update(font).digest('hex') !== FONT_SHA256) {
  failures.push('docs/stylesheets/fonts/inter-latin-wght-normal.woff2 drifted from the shared family font');
}

const mkdocs = readFileSync(join(ROOT, 'mkdocs.yml'), 'utf8');
for (const needle of ['stylesheets/tokens.css', 'stylesheets/brand.css', 'primary: custom']) {
  if (!mkdocs.includes(needle)) failures.push(`mkdocs.yml is missing ${needle}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`brand: ${failure}`);
  process.exit(1);
}
console.log(`brand tokens OK (${CANONICAL_COMMIT})`);
