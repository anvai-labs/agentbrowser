#!/usr/bin/env node
/** Layering ratchet (hygiene program Phase 3.1, 2026-10-23).
 *
 * Every import of one workspace package from another must land on a package the
 * importer DECLARES in its package.json (dependencies or devDependencies). The
 * baseline is 0 undeclared pairs by construction — Phase 1.1 measured 585/585
 * imports declared. Shrink-only: a new undeclared import fails CI here; there is
 * nothing to lower because the floor is zero.
 *
 * Blind spots (inherited from static string matching): dynamic imports built from
 * computed strings, and re-exports through barrels — both are rare here by
 * convention (packages import deep paths), and the check errs on the side of
 * missing them, not false positives.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const pkgs = readdirSync(join(ROOT, 'packages')).filter((p) => {
  try {
    return statSync(join(ROOT, 'packages', p, 'package.json')).isFile();
  } catch {
    return false;
  }
});

const nameOf = {};
for (const p of pkgs) {
  const json = JSON.parse(readFileSync(join(ROOT, 'packages', p, 'package.json'), 'utf8'));
  nameOf[json.name] = p;
  nameOf[p] = p;
}
const depsOf = {};
for (const p of pkgs) {
  const json = JSON.parse(readFileSync(join(ROOT, 'packages', p, 'package.json'), 'utf8'));
  depsOf[p] = new Set(
    [...Object.keys(json.dependencies ?? {}), ...Object.keys(json.devDependencies ?? {})]
      .filter((d) => nameOf[d])
      .map((d) => nameOf[d])
  );
}

const results = [];
for (const p of pkgs) {
  const srcDir = join(ROOT, 'packages', p, 'src');
  let files = [];
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
      else if (/\.(ts|mjs|mts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) files.push(full);
    }
  };
  walk(srcDir);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const re =
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](@agentbrowser\/[a-z-]+|@anvailabs\/[a-z-]+)['"]/g;
    let m;
    while ((m = re.exec(text))) {
      const target = nameOf[m[1]];
      if (!target || target === p) continue;
      results.push({ pkg: p, target, declared: depsOf[p].has(target), file: f });
    }
  }
}

const leaks = results.filter((r) => !r.declared);
if (leaks.length > 0) {
  const pairs = new Map();
  for (const l of leaks) pairs.set(`${l.pkg} -> ${l.target}`, (pairs.get(`${l.pkg} -> ${l.target}`) ?? 0) + 1);
  console.error(`LAYERING RATCHET: ${leaks.length} undeclared workspace import(s) across ${pairs.size} pair(s):`);
  for (const [k, n] of pairs) console.error(`  ${n} imports  ${k}`);
  console.error('Declare the dependency in the importer\'s package.json, or remove the import.');
  process.exit(1);
}
console.log(`layering ratchet: ${results.length} workspace imports, 0 undeclared — OK`);
