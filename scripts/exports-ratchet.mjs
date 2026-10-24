#!/usr/bin/env node
/** Unused-export ratchet (hygiene program Phase 3.1/3.3, 2026-10-23).
 *
 * Counts exports in non-public-API packages with zero references outside their own
 * file (grep-based — the codegraph's cross-module refs are absent for TS). Shrink-
 * only BOTH directions, like the duplication ratchet: growth fails; a real reduction
 * must claim the lower baseline in the same PR.
 *
 * protocol/ and sdk-typescript/ are exempt: their exports ARE the published SDK
 * surface — in-repo usage is not the test for them.
 *
 * Baseline history:
 *   2026-10-23  0 (post #626's de-export sweep — the floor, like layering)
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASELINE = 0;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_API = new Set(['protocol', 'sdk-typescript']);

const files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((f) => /^packages\/[^/]+\/src\/.*\.ts$/.test(f) && !/\.test\.|\.spec\.|test-support|\.d\.ts/.test(f));

const offenders = [];
for (const f of files) {
  const pkg = f.split('/')[1];
  if (PUBLIC_API.has(pkg)) continue;
  const text = readFileSync(join(ROOT, f), 'utf8');
  for (const m of text.matchAll(/^export (?:async )?function (\w+)|^export const (\w+) = /gm)) {
    const name = m[1] || m[2];
    if (!name) continue;
    let ext = 0;
    try {
      ext = parseInt(
        execSync(`git grep -lw ${name} | grep -v '${f}' | wc -l`, { cwd: ROOT, encoding: 'utf8', shell: '/bin/bash' }).trim()
      );
    } catch {
      ext = 0;
    }
    if (ext === 0) offenders.push(`${pkg}::${name} (${f.replace('packages/', '')})`);
  }
}

console.log(`exports ratchet: ${offenders.length} zero-external-reference exports (baseline ${BASELINE})`);
if (offenders.length > BASELINE) {
  console.error('EXPORTS RATCHET: new unused exports (or baseline raised without cause):');
  offenders.forEach((o) => console.error(`  ${o}`));
  console.error('Use the symbol, de-export it, or delete it — then lower the baseline if this was a real reduction.');
  process.exit(1);
}
if (offenders.length < BASELINE) {
  console.error(`EXPORTS RATCHET: fell to ${offenders.length} < baseline ${BASELINE} — lower BASELINE in this PR.`);
  process.exit(1);
}
console.log('exports ratchet: OK');
