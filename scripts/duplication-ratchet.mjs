#!/usr/bin/env node
/** Duplication ratchet (hygiene program Phase 3.1, 2026-10-23).
 *
 * Runs jscpd (pinned 5.4.2, window 100, strict — the stable window; 50 is dominated
 * by deliberate test explicitness) over packages/ and gates on TOTAL duplicated
 * tokens. Shrink-only: the committed baseline may only go DOWN. A PR that adds
 * duplication above the baseline fails here; lowering the baseline requires lowering
 * actual duplication in the same PR (edit the number below WITH the dedup).
 *
 * Baseline history:
 *   2026-10-23  4373 tokens (38 pairs, 564 lines) — post pass-1..4 + #619..#624
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASELINE_DUPLICATED_TOKENS = 4373;
const MIN_TOKENS = 100;

const out = execFileSync(
  'npx',
  [
    '--yes',
    'jscpd@5.4.2',
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
    '.tmp/jscpd-ratchet',
    '--ignore',
    '**/dist/**,**/coverage/**,**/node_modules/**,**/*.d.ts,**/generated/**',
  ],
  { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname }
);

const report = JSON.parse(readFileSync('.tmp/jscpd-ratchet/jscpd-report.json', 'utf8'));
const total = report.statistics.total;
console.log(
  `duplication ratchet (window ${MIN_TOKENS}): ${total.clones} pairs, ${total.duplicatedTokens} duplicated tokens (baseline ${BASELINE_DUPLICATED_TOKENS})`
);
if (total.duplicatedTokens > BASELINE_DUPLICATED_TOKENS) {
  console.error(
    `DUPLICATION RATCHET: ${total.duplicatedTokens} > baseline ${BASELINE_DUPLICATED_TOKENS} (+${total.duplicatedTokens - BASELINE_DUPLICATED_TOKENS}).`
  );
  console.error('Deduplicate the new clones in this PR, or lower real duplication first.');
  process.exit(1);
}
if (total.duplicatedTokens < BASELINE_DUPLICATED_TOKENS) {
  console.log(
    `duplication fell below baseline — lower the BASELINE_DUPLICATED_TOKENS to ${total.duplicatedTokens} in this PR (shrink-only ratchet).`
  );
}
console.log('duplication ratchet: OK');
