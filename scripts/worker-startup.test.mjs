import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { verifyStartup, verifyStartupCase } from './probes/verify-worker-startup.mjs';

const fixture = () => ({
  arm: 'recursive', mode: 'external-dedicated', holdMs: 200, errors: [],
  workers: [{ token: 'recursive/external-dedicated/1', parentToken: null, urlKey: 'a' }],
  results: [{ token: 'recursive/external-dedicated/1', status: 200, body: 'worker-startup-ok' }],
  events: [
    { kind: 'root-setup', at: 1 },
    { kind: 'launch', at: 2 },
    { kind: 'attached', at: 3, sessionId: 's1', parentSessionId: null, targetId: 't1', urlKey: 'a', waitingForDebugger: true, targetType: 'worker' },
    { kind: 'recursive-setup', at: 4, sessionId: 's1' },
    { kind: 'hit', at: 5, token: 'recursive/external-dedicated/1', method: 'GET' },
    { kind: 'release-dispatch', at: 204, sessionId: 's1' },
    { kind: 'release-ack', at: 205, sessionId: 's1' },
  ],
  cleanup: { pending: 0, tasks: 0, listeners: 0, contextClosed: true },
});

test('a successful sentinel before release falsifies pause ownership', () => {
  const result = verifyStartupCase(fixture());
  assert.equal(result[0].classification, 'preReleaseExecutionObserved');
});

test('a later hit is only bounded observation, not security acceptance', () => {
  const row = fixture();
  row.events.find(event => event.kind === 'hit').at = 206;
  row.events.sort((a, b) => a.at - b.at);
  assert.equal(verifyStartupCase(row)[0].classification, 'noPreReleaseHitWithinWindow');
});

test('successful shared workers without attachment are uncovered', () => {
  const row = fixture();
  row.mode = 'external-shared';
  for (const entry of [...row.workers, ...row.results, ...row.events.filter(event => event.token)]) entry.token = 'recursive/external-shared/1';
  row.events = row.events.filter(event => ['root-setup', 'launch', 'hit'].includes(event.kind));
  assert.equal(verifyStartupCase(row)[0].classification, 'uncoveredTarget');
});

for (const [name, mutate] of [
  ['missing server hit', row => { row.events = row.events.filter(event => event.kind !== 'hit'); }],
  ['bad positive body', row => { row.results[0].body = 'wrong'; }],
  ['duplicate token', row => { row.workers.push(row.workers[0]); }],
  ['short hold', row => { row.events.find(event => event.kind === 'release-dispatch').at = 100; }],
  ['setup after release', row => { row.events.find(event => event.kind === 'recursive-setup').at = 206; }],
  ['wrong lineage', row => { row.events.find(event => event.kind === 'attached').parentSessionId = 'foreign'; }],
  ['pending cleanup', row => { row.cleanup.pending = 1; }],
  ['handler failure', row => { row.errors.push('failed'); }],
  ['sessionless release event', row => { row.events.push({ kind: 'release-ack', at: 207 }); }],
]) test(`invalid evidence rejects ${name}`, () => {
  const row = fixture();
  mutate(row);
  assert.throws(() => verifyStartupCase(row));
});

const recorded = () => readFileSync(new URL('../docs/evidence/worker-startup.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('recorded native controls and startup violations remain explicit', () => {
  const report = verifyStartup(recorded());
  assert.equal(report.securityAcceptance, false);
  assert.equal(report.completePreExecutionCoverage, false);
  const counts = {};
  for (const outcome of report.outcomes) counts[outcome.classification] = (counts[outcome.classification] ?? 0) + 1;
  assert.deepEqual(counts, { nativeControl: 9, preReleaseExecutionObserved: 12, uncoveredTarget: 6 });
});

test('reviewed cleanup rerun reproduces the same per-worker classifications', () => {
  const reviewed = readFileSync(new URL('../docs/evidence/worker-startup-reviewed.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(reviewed.at(-1).errors, []);
  const project = rows => verifyStartup(rows).outcomes.map(({ token, classification }) => ({ token, classification }));
  assert.deepEqual(project(reviewed), project(recorded()));
  reviewed.at(-1).errors.push('browser close failed');
  assert.throws(() => verifyStartup(reviewed));
});

test('each nested worker is compared with its own release, not its parent release', () => {
  const row = recorded().find(row => row.arm === 'recursive' && row.mode === 'nested-external');
  const releases = row.events.filter(event => event.kind === 'release-dispatch');
  const hit = row.events.find(event => event.kind === 'hit' && event.token.endsWith('/2'));
  hit.at = (releases[0].at + releases[1].at) / 2;
  row.events.sort((a, b) => a.at - b.at);
  assert.equal(verifyStartupCase(row)[1].classification, 'preReleaseExecutionObserved');
});

for (const [name, mutate] of [
  ['missing matrix case', rows => { rows.splice(1, 1); }],
  ['duplicate matrix case', rows => { rows[1] = rows[2]; }],
  ['foreign request token', rows => { rows[1].events.find(event => event.kind === 'hit').token = 'foreign'; }],
  ['foreign attachment URL', rows => { rows.find(row => row.arm === 'recursive').events.find(event => event.kind === 'attached').urlKey = 'foreign'; }],
  ['broken nested parent', rows => { rows.find(row => row.arm === 'recursive' && row.mode === 'nested-external').workers[1].parentToken = 'foreign'; }],
  ['leaked server socket', rows => { rows.at(-1).sockets = 1; }],
  ['security acceptance claim', rows => { rows[0].securityAcceptance = true; }],
]) test(`recorded evidence rejects ${name}`, () => {
  const rows = recorded();
  mutate(rows);
  assert.throws(() => verifyStartup(rows));
});
