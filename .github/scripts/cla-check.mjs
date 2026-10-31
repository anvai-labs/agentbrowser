#!/usr/bin/env node
// Lightweight CLA gate. A PR passes when its author has already signed
// (.github/cla-signatories.json, maintained by maintainers) or checks the CLA box
// in the PR description — the checked box plus the PR's edit history is the
// signature record. Bot accounts are exempt.
//
// Runs from a base-ref checkout only (never executes PR code) and reads the PR
// body as data, so it is safe under the default `pull_request` event.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MARKER = /\[x\]\s*i have signed the contributor license agreement/i;
const EXEMPT = new Set([
  'dependabot[bot]',
  'github-actions[bot]',
  'renovate[bot]',
  'coderabbitai[bot]',
]);

const author = process.env.PR_AUTHOR ?? '';
const body = process.env.PR_BODY ?? '';
const action = process.env.PR_ACTION ?? '';

const { signatories } = JSON.parse(readFileSync('.github/cla-signatories.json', 'utf8'));

if (signatories.includes(author) || EXEMPT.has(author)) {
  console.log(`CLA: ${author} is a recorded signatory${EXEMPT.has(author) ? ' (exempt bot)' : ''}.`);
  process.exit(0);
}

if (MARKER.test(body)) {
  console.log(`CLA: ${author} signed via the PR-description checkbox.`);
  console.log(
    'Maintainers: after merge, consider adding this author to .github/cla-signatories.json ' +
      'so their future PRs pass without re-checking the box.',
  );
  process.exit(0);
}

console.error(`::error title=CLA not signed::${author} has not signed the CLA. Read .github/CLA.md, then check the CLA box in the PR description.`);

if (action === 'opened') {
  const comment = [
    '<!-- cla-check -->',
    'Thanks for the PR! Before review, we need a one-time CLA signature:',
    '',
    '1. Read the [Contributor License Agreement](../blob/develop/.github/CLA.md).',
    '2. Edit this PR description and check this box, keeping the wording:',
    '',
    '   - [x] I have signed the Contributor License Agreement',
    '',
    'The checked box and the PR edit history are the signature record. A maintainer will',
    'then add you to `.github/cla-signatories.json` so future PRs pass automatically.',
  ].join('\n');
  execFileSync('gh', ['pr', 'comment', String(process.env.PR_NUMBER), '--body', comment], {
    stdio: 'inherit',
  });
}

process.exit(1);
