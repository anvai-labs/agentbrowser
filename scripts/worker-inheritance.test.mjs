import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { verifyInheritanceEvidence } from './probes/verify-worker-inheritance.mjs';

const fixture = () => readFileSync(new URL('../docs/evidence/worker-csp-inheritance.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line));

test('retained comparison is valid evidence, not a passed security gate', () => {
  const summary = verifyInheritanceEvidence(fixture());
  assert.equal(summary.fixtureValid, true);
  assert.equal(summary.securityAcceptance, false);
  assert.equal(summary.cases, 36);
  assert.deepEqual(summary.nonStrictHttpFailures.map(row => row.arm),
    ['network-fulfilled', 'fulfilled-control', 'fulfilled-policy']);
});

test('missing worker results cannot masquerade as zero forbidden hits', () => {
  assert.throws(() => verifyInheritanceEvidence(fixture().filter(row => row.mode !== 'data-dedicated')));
});

test('HTTP positive control requires the sentinel body, not only status 200', () => {
  const rows = fixture();
  rows.find(row => row.type === 'result').result.http.body = 'wrong';
  assert.throws(() => verifyInheritanceEvidence(rows));
});

test('late server hits invalidate the immediate result snapshots', () => {
  const rows = fixture();
  rows.find(row => row.type === 'final-hits').hits.push({ kind: 'ws', arm: 'native-policy', mode: 'data-dedicated' });
  assert.throws(() => verifyInheritanceEvidence(rows));
});

test('generic socket errors do not establish native CSP enforcement', () => {
  const rows = fixture();
  rows.find(row => row.type === 'result' && row.arm === 'native-policy').result.diagnostics.violations = [];
  assert.throws(() => verifyInheritanceEvidence(rows));
});

test('a caught interception error invalidates the experiment', () => {
  const rows = fixture();
  rows.find(row => row.type === 'coverage').handlerErrors.push({ error: 'command failed' });
  assert.throws(() => verifyInheritanceEvidence(rows));
});

test('cleanup and diagnostic loss must be visible', () => {
  const rows = fixture();
  rows.find(row => row.type === 'cleanup').ownedBrowserStopped = false;
  assert.throws(() => verifyInheritanceEvidence(rows));
  const dropped = fixture();
  dropped.find(row => row.type === 'diagnostics').droppedDiagnostics = 1;
  assert.throws(() => verifyInheritanceEvidence(dropped));
});

test('missing delivery coverage and altered replay headers are rejected', () => {
  for (const field of ['paused', 'injected']) {
    const rows = fixture();
    rows.find(row => row.type === 'coverage')[field] = [];
    assert.throws(() => verifyInheritanceEvidence(rows));
  }
  const rows = fixture();
  rows.find(row => row.type === 'coverage').injected[0].finalHeaders.shift();
  assert.throws(() => verifyInheritanceEvidence(rows));
});

test('every claimed injected-policy socket denial needs violation evidence', () => {
  for (const arm of ['added-policy', 'network-fulfilled', 'fulfilled-policy']) {
    const rows = fixture();
    rows.find(row => row.type === 'result' && row.arm === arm).result.diagnostics.violations = [];
    assert.throws(() => verifyInheritanceEvidence(rows));
  }
});

test('data-worker failure must have correlated response-error evidence', () => {
  const rows = fixture();
  const coverage = rows.find(row => row.type === 'coverage');
  coverage.paused = coverage.paused.filter(row => !row.responseErrorReason);
  assert.throws(() => verifyInheritanceEvidence(rows));
});
