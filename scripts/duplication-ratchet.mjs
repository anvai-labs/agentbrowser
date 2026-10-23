#!/usr/bin/env node
/** Duplication ratchet (hygiene program Phase 3.1, 2026-10-23).
 *
 * Runs jscpd (pinned as a root devDependency — full transitive tree locked in
 * pnpm-lock.yaml) over packages/ at window 100, strict — the stable window; 50 is
 * dominated by deliberate test explicitness. Gates on TOTAL duplicated tokens.
 * True ratchet semantics: actual > baseline fails (new duplication); actual <
 * baseline ALSO fails, telling the author to lower the constant in the same PR —
 * unclaimed slack can never permit re-growth.
 *
 * Baseline history:
 *   2026-10-23  4373 tokens (38 pairs, 564 lines) — post pass-1..4 + #619..#624
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASELINE_DUPLICATED_TOKENS = 4373;
const MIN_TOKENS = 100;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPORT = join(ROOT, '.tmp', 'jscpd-ratchet', 'jscpd-report.json');

execFileSync(
  process.execPath,
  [
    // pnpm nests the package; resolve the bin entry from the installed manifest.
    join(
      fileURLToPath(new URL('../node_modules/.pnpm', import.meta.url)),
      `jscpd@5.4.2`,
      'node_modules',
      'jscpd',
      'run-jscpd.js'
    ),
    'packages',
    '--format',
    'typescript',
    '--min-tokens',
    String(MIN_TOKENS),
    '--mode',
    'strict',
    '--reporters',
    'json',
    '--output',
    join(ROOT, '.tmp', 'jscpd-ratchet'),
    '--ignore',
    '**/dist/**,**/coverage/**,**/node_modules/**,**/*.d.ts,**/generated/**',
  ],
  { cwd: ROOT, stdio: 'inherit' }
);

const report = JSON.parse(readFileSync(REPORT, 'utf8'));
const total = report.statistics.total;
console.log(
  `duplication ratchet (window ${MIN_TOKENS}): ${total.clones} pairs, ${total.duplicatedTokens} duplicated tokens (baseline ${BASELINE_DUPLICATED_TOKENS})`
);
if (total.duplicatedTokens > BASELINE_DUPLICATED_TOKENS) {
  console.error(
    `DUPLICATION RATCHET: ${total.duplicatedTokens} > baseline ${BASELINE_DUPLICATED_TOKENS} (+${total.duplicatedTokens - BASELINE_DUPLICATED_TOKENS}).`
  );
  console.error('Deduplicate the new clones in this PR.');
  process.exit(1);
}
if (total.duplicatedTokens < BASELINE_DUPLICATED_TOKENS) {
  console.error(
    `DUPLICATION RATCHET: duplication fell to ${total.duplicatedTokens} < baseline ${BASELINE_DUPLICATED_TOKENS}.`
  );
  console.error(
    `Lower BASELINE_DUPLICATED_TOKENS to ${total.duplicatedTokens} in this same PR — unclaimed slack is not allowed.`
  );
  process.exit(1);
}
console.log('duplication ratchet: OK');
