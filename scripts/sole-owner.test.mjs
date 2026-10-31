import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { executeWorker } from './probes/worker-startup-fixture.mjs';
import { verifySoleOwner } from './probes/verify-sole-owner.mjs';
const recorded = () => readFileSync(new URL('../docs/evidence/sole-owner.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);

test('shared worker body is byte-identical to the T1b serialized function', () => {
  assert.equal(createHash('sha256').update(executeWorker.toString()).digest('hex'), 'c40b54795965ece1481607f84bba87502d5db47cea5badd102667f8ab7ba3341');
});

test('recorded controls remain valid without requiring competitor early execution', () => {
  const report = verifySoleOwner(recorded());
  assert.equal(report.securityAcceptance, false);
  assert.equal(report.outcomes.length, 27);
  assert(report.outcomes.every(outcome => outcome.classification === 'noPreReleaseHitObserved'));
  assert(report.outcomes.filter(outcome => outcome.token.startsWith('competitor/')).every(outcome => outcome.competitorReleasedBeforePrimary));
});

test('reviewed repeat preserves classification and validates setup/cleanup instrumentation', () => {
  const rows = readFileSync(new URL('../docs/evidence/sole-owner-reviewed.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
  const project = input => verifySoleOwner(input).outcomes.map(({ token, classification, competitorReleasedBeforePrimary }) => ({ token, classification, competitorReleasedBeforePrimary }));
  assert.equal(rows[0].instrumentation, 2);
  assert.deepEqual(project(rows), project(recorded()));
  rows[1].events.find(event => event.parameters).parameters.waitForDebuggerOnStart = false;
  assert.throws(() => verifySoleOwner(rows));
});

test('an early competitor hit is classified, not rejected as a bad positive control', () => {
  const rows = recorded();
  const row = rows.find(row => row.arm === 'competitor');
  const hit = row.events.find(event => event.kind === 'hit');
  const release = row.events.find(event => event.kind === 'command-send' && event.owner === 'primary' && event.method === 'Runtime.runIfWaitingForDebugger');
  hit.at = release.at - 10;
  row.events.sort((a, b) => a.at - b.at);
  assert(verifySoleOwner(rows).outcomes.some(outcome => outcome.classification === 'preReleaseExecutionObserved'));
});

for (const [name, mutate] of [
  ['missing case', rows => rows.splice(1, 1)],
  ['duplicate repeat', rows => { rows[1] = rows[3]; }],
  ['wrong body', rows => { rows[1].results[0].body = 'wrong'; }],
  ['missing hit', rows => { rows[1].events = rows[1].events.filter(event => event.kind !== 'hit'); }],
  ['missing script request', rows => { rows[1].events = rows[1].events.filter(event => event.kind !== 'script-request'); }],
  ['session identity collision', rows => { rows[1].events.find(event => event.kind === 'command-ack').sessionId = 'foreign'; }],
  ['unacknowledged command', rows => { rows[1].events = rows[1].events.filter(event => !(event.kind === 'command-ack' && event.method === 'Runtime.runIfWaitingForDebugger')); }],
  ['cross-owner target mismatch', rows => { rows.find(row => row.arm === 'competitor').events.find(event => event.kind === 'attached' && event.owner === 'competitor').targetId = 'foreign'; }],
  ['bad parent lineage', rows => { rows.find(row => row.mode === 'nested-external').events.filter(event => event.kind === 'attached')[1].parentSessionId = 'foreign'; }],
  ['short delayed hold', rows => { const row = rows.find(row => row.arm === 'delayed'); const release = row.events.find(event => event.kind === 'command-send' && event.method === 'Runtime.runIfWaitingForDebugger'); release.at -= 100; row.events.sort((a, b) => a.at - b.at); }],
  ['live browser process', rows => { rows.at(-1).processExited = false; }],
  ['profile left behind', rows => { rows.at(-1).profileRemoved = false; }],
  ['cleanup failure', rows => { rows.at(-1).errors.push('failed'); }],
]) test(`verifier rejects ${name}`, () => {
  const rows = recorded(); mutate(rows); assert.throws(() => verifySoleOwner(rows));
});
