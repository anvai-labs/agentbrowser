import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { verifyWorkerNetwork } from './probes/verify-worker-network.mjs';
const read = name => readFileSync(new URL(`../docs/evidence/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const baseline = () => read('worker-csp-inheritance');
const fixture = () => read('worker-network-diagnostics');

test('diagnostic attribution preserves the missing-start blind spot', () => {
  const result = verifyWorkerNetwork(fixture(), baseline());
  assert.equal(result.cases, 27);
  assert.equal(result.localNetworkDenials.length, 3);
  assert.deepEqual(result.missingRequestStarts, [{ arm: 'native-control', mode: 'external-dedicated' }]);
  assert.equal(result.completePreExecutionCoverage, false);
  assert.equal(result.securityAcceptance, false);
});

test('missing worker failure or changed blocking reason is rejected', () => {
  for (const change of ['remove', 'reason']) {
    const rows = fixture();
    const diagnostics = rows.find(row => row.type === 'diagnostics');
    if (change === 'remove') diagnostics.records = diagnostics.records.filter(row => row.method !== 'Network.loadingFailed');
    else diagnostics.records.find(row => row.method === 'Network.loadingFailed').params.corsErrorStatus.corsError = 'Unexpected';
    assert.throws(() => verifyWorkerNetwork(rows, baseline()));
  }
});

test('cross-session identity and missing positive response coverage are rejected', () => {
  for (const kind of ['identity', 'coverage']) {
    const rows = fixture();
    const records = rows.find(row => row.type === 'diagnostics').records;
    if (kind === 'identity') records.find(row => row.method === 'Network.loadingFailed').sessionId = 'other';
    else records.splice(records.findIndex(row => row.method === 'Network.responseReceived'), 1);
    assert.throws(() => verifyWorkerNetwork(rows, baseline()));
  }
});

test('observer lifecycle acknowledgements and pending work cannot be omitted', () => {
  for (const kind of ['worker-network-enabled', 'worker-resumed', 'worker-detached', 'worker-observer-cleanup']) {
    const rows = fixture();
    const diagnostics = rows.find(row => row.type === 'diagnostics');
    diagnostics.records = diagnostics.records.filter(row => row.kind !== kind);
    assert.throws(() => verifyWorkerNetwork(rows, baseline()));
  }
});

test('generic no-policy socket errors cannot be called local-network denials', () => {
  const rows = fixture();
  rows.find(row => row.type === 'diagnostics').records.find(row => row.method === 'Network.webSocketFrameError').params.errorMessage = 'connection failed';
  assert.throws(() => verifyWorkerNetwork(rows, baseline()));
});
