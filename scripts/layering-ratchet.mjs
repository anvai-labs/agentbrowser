#!/usr/bin/env node
/** Layering ratchet (hygiene program Phase 3.1, 2026-10-23).
 *
 * Every import of one workspace package from another — INCLUDING deep subpaths
 * (`@agentbrowser/core/private-file`) — must land on a package the importer
 * DECLARES in its package.json. The baseline is 0 undeclared pairs by
 * construction. Shrink-only: a new undeclared import fails CI here.
 *
 * Blind spots (inherited from static string matching): dynamic imports built from
 * computed strings, and re-exports through barrels — both are rare here by
 * convention; the check errs toward missing them, not false positives.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// pnpm-workspace.yaml globs (packages/*, apps/*, tests/*) — expand the dirs that exist.
const WORKSPACE_DIRS = ['packages', 'apps', 'tests'].filter((d) => {
  try {
    return statSync(join(ROOT, d)).isDirectory();
  } catch {
    return false;
  }
});

const nameOf = {};
const pkgDirs = [];
for (const dir of WORKSPACE_DIRS) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(dir, entry.name);
    try {
      const json = JSON.parse(readFileSync(join(ROOT, p, 'package.json'), 'utf8'));
      nameOf[json.name] = p;
      pkgDirs.push(p);
    } catch {
      /* not a package */
    }
  }
}
const depsOf = {};
for (const p of pkgDirs) {
  const json = JSON.parse(readFileSync(join(ROOT, p, 'package.json'), 'utf8'));
  depsOf[p] = new Set(
    [...Object.keys(json.dependencies ?? {}), ...Object.keys(json.devDependencies ?? {})]
      .filter((d) => nameOf[d])
      .map((d) => nameOf[d])
  );
}

export const WORKSPACE_IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](@agentbrowser\/[a-z0-9-]+|@anvailabs\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g;

export function countWorkspaceImports(sources, declaredFn) {
  /** sources: Array<{ pkg, target, text }> -> results with .declared */
  const results = [];
  for (const s of sources) {
    let m;
    const re = new RegExp(WORKSPACE_IMPORT_RE.source, 'g');
    while ((m = re.exec(s.text))) {
      const target = nameOf[m[1]] ? m[1] : undefined;
      if (!target) continue;
      results.push({ pkg: s.pkg, target, declared: declaredFn(s.pkg, target), match: m[0] });
    }
  }
  return results;
}

const results = [];
for (const p of pkgDirs) {
  const srcDir = join(ROOT, p, 'src');
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'dist' || e.name === 'node_modules') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|mjs|mts)$/.test(e.name) && !/\.d\.ts$/.test(e.name))
        results.push({ pkg: p, target: null, text: readFileSync(full, 'utf8'), file: full });
    }
  };
  walk(srcDir);
}

const imports = countWorkspaceImports(
  results.map((r) => ({ ...r, target: undefined })),
  (pkg, target) => depsOf[pkg]?.has(nameOf[target]) ?? false
).filter((r) => nameOf[r.target] !== r.pkg);

const leaks = imports.filter((r) => !r.declared);
if (leaks.length > 0) {
  const pairs = new Map();
  for (const l of leaks)
    pairs.set(`${l.pkg} -> ${l.target}`, (pairs.get(`${l.pkg} -> ${l.target}`) ?? 0) + 1);
  console.error(
    `LAYERING RATCHET: ${leaks.length} undeclared workspace import(s) across ${pairs.size} pair(s):`
  );
  for (const [k, n] of pairs) console.error(`  ${n} imports  ${k}`);
  console.error("Declare the dependency in the importer's package.json, or remove the import.");
  process.exit(1);
}
console.log(
  `layering ratchet: ${imports.length} workspace imports (incl. deep paths), 0 undeclared — OK`
);
