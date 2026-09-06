// Verifies the diagnostic attribution, not a network enforcement boundary.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyInheritanceEvidence } from './verify-worker-inheritance.mjs';

export function verifyWorkerNetwork(rows, baseline) {
  const summary = verifyInheritanceEvidence(rows);
  verifyInheritanceEvidence(baseline);
  const env = rows.find(row => row.type === 'environment');
  assert.equal(env.workerNetwork, true);
  const records = rows.find(row => row.type === 'diagnostics').records;
  const results = rows.filter(row => row.type === 'result');
  const coverage = rows.find(row => row.type === 'coverage');
  const attaches = records.filter(row => row.kind === 'worker-attached');
  assert.equal(attaches.length, results.length);
  assert.equal(new Set(attaches.map(row => row.sessionId)).size, results.length);
  const missingRequestStarts = [];
  const localNetworkDenials = [];
  const tuple = row => ({ http: { status: row.result.http.status, body: row.result.http.body, error: row.result.http.error },
    ws: row.result.ws, wss: row.result.wss, hits: row.hits.map(hit => ({ kind: hit.kind, method: hit.method })) });
  for (const row of results) {
    const { arm, mode, result } = row;
    const control = baseline.filter(item => item.type === 'result' && item.arm === arm && item.mode === mode);
    assert.equal(control.length, 1);
    assert.deepEqual(tuple(row), tuple(control[0]), 'diagnostic observer changed control outcomes');
    const attached = attaches.filter(item => item.arm === arm && item.mode === mode);
    assert.equal(attached.length, 1);
    const { sessionId } = attached[0];
    assert.equal(attached[0].targetType, 'worker');
    assert.equal(attached[0].waitingForDebugger, true);
    const events = records.filter(item => item.sessionId === sessionId);
    const oneKind = kind => {
      const found = events.filter(item => item.kind === kind);
      assert.equal(found.length, 1, `missing ${kind}`);
      return found[0];
    };
    const enabled = oneKind('worker-network-enabled');
    oneKind('worker-resumed');
    assert.equal(oneKind('worker-detached').pendingCommands, 0);
    const matchesUrl = (url, path) => {
      const parsed = new URL(url);
      return parsed.pathname === path && parsed.searchParams.get('arm') === arm && parsed.searchParams.get('mode') === mode;
    };
    const network = events.filter(item => item.kind === 'worker-network');
    const requests = network.filter(item => item.method === 'Network.requestWillBeSent' && matchesUrl(item.params.request.url, '/probe'));
    if (result.http.status === 200) {
      const responses = network.filter(item => item.method === 'Network.responseReceived' && matchesUrl(item.params.response.url, '/probe'));
      assert.equal(responses.length, 1);
      const response = responses[0];
      assert.equal(response.params.response.status, 200);
      assert.ok(network.some(item => item.method === 'Network.loadingFinished' && item.params.requestId === response.params.requestId));
      if (requests.length === 0) missingRequestStarts.push({ arm, mode });
      else {
        assert.equal(requests.length, 1);
        assert.equal(requests[0].params.requestId, response.params.requestId);
        assert.ok(events.indexOf(enabled) < events.indexOf(requests[0]));
      }
    } else if (arm !== 'strict-fulfilled') {
      assert.equal(requests.length, 1, 'failure needs worker request identity');
      const failures = network.filter(item => item.method === 'Network.loadingFailed' && item.params.requestId === requests[0].params.requestId);
      assert.equal(failures.length, 1);
      const failure = failures[0];
      assert.equal(failure.params.canceled, false);
      assert.equal(failure.params.errorText, 'net::ERR_FAILED');
      assert.equal(failure.params.corsErrorStatus?.corsError, 'LocalNetworkAccessPermissionDenied');
      assert.ok(events.indexOf(enabled) < events.indexOf(requests[0]));
      assert.ok(events.indexOf(requests[0]) < events.indexOf(failure));
      assert.ok(coverage.paused.some(item => item.arm === arm && item.mode === mode && item.path === '/probe' &&
        item.stage === 'response' && item.responseErrorReason === 'Failed' && item.networkId === failure.params.requestId));
      localNetworkDenials.push({ arm, mode });
    }
    if (arm === 'fulfilled-control') {
      for (const scheme of ['ws:', 'wss:']) {
        const sockets = network.filter(item => item.method === 'Network.webSocketCreated' &&
          new URL(item.params.url).protocol === scheme && matchesUrl(item.params.url, '/socket'));
        assert.equal(sockets.length, 1);
        const errors = network.filter(item => item.method === 'Network.webSocketFrameError' && item.params.requestId === sockets[0].params.requestId);
        assert.equal(errors.length, 1);
        assert.match(errors[0].params.errorMessage, /net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS$/);
      }
    }
  }
  for (const arm of env.arms) {
    const cleanups = records.filter(row => row.kind === 'worker-observer-cleanup' && row.arm === arm);
    assert.equal(cleanups.length, 1);
    assert.equal(cleanups[0].remainingChildren, 0);
    assert.equal(cleanups[0].pendingCommands, 0);
  }
  return { ...summary, localNetworkDenials, missingRequestStarts, completePreExecutionCoverage: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 4, 'usage: node scripts/probes/verify-worker-network.mjs diagnostic.jsonl baseline.jsonl');
  const read = file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  console.log(JSON.stringify(verifyWorkerNetwork(read(process.argv[2]), read(process.argv[3]))));
}
