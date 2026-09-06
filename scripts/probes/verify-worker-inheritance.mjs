// Validates diagnostic evidence, never certifies production enforcement.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function verifyInheritanceEvidence(rows) {
  const one = type => {
    const matches = rows.filter(row => row.type === type);
    assert.equal(matches.length, 1, `expected one ${type} record`);
    return matches[0];
  };
  const env = one('environment');
  const arms = ['native-control', 'native-policy', 'control', 'network-policy', 'network-fulfilled',
    'added-policy', 'fulfilled-control', 'fulfilled-policy', 'strict-fulfilled'];
  const modes = ['external-dedicated', 'blob-dedicated', 'blob-shared', 'data-dedicated'];
  assert.deepEqual(env.arms, arms);
  assert.deepEqual(env.modes, modes);
  assert.equal(env.addedPolicy, 'connect-src http: https:');
  assert.ok(env.browserVersion);
  assert.equal(rows.filter(row => row.type === 'probe-error').length, 0);
  const coverage = one('coverage');
  assert.deepEqual(coverage.handlerErrors, []);
  assert.equal(coverage.paused.filter(row => row.arm.startsWith('native-')).length, 0);
  assert.equal(one('diagnostics').droppedDiagnostics, 0);
  assert.equal(one('cleanup').ownedBrowserStopped, true);
  assert.equal(one('cleanup').remainingSockets, 0);
  const finalHits = one('final-hits').hits;
  const results = rows.filter(row => row.type === 'result');
  assert.equal(results.length, arms.length * modes.length);
  const navigations = rows.filter(row => row.type === 'navigation');
  assert.equal(navigations.length, arms.length);
  const changedArms = ['network-fulfilled', 'added-policy', 'fulfilled-control', 'fulfilled-policy', 'strict-fulfilled'];
  assert.equal(coverage.injected.length, changedArms.length * 2);
  for (const arm of arms) {
    const navigation = navigations.filter(row => row.arm === arm);
    assert.equal(navigation.length, 1);
    assert.equal(navigation[0].url, navigation[0].expectedUrl);
    for (const path of ['/page', '/worker.js']) {
      if (!arm.startsWith('native-')) {
        const pauses = coverage.paused.filter(row => row.arm === arm && row.path === path);
        assert.equal(pauses.length, 2, 'missing document/worker interception coverage');
        assert.deepEqual(pauses.map(row => row.stage), ['request', 'response']);
        assert.ok(pauses[0].requestId && pauses[0].networkId);
        assert.equal(pauses[0].requestId, pauses[1].requestId);
        assert.equal(pauses[0].networkId, pauses[1].networkId);
      }
      if (!changedArms.includes(arm)) continue;
      const deliveries = coverage.injected.filter(row => row.arm === arm && row.path === path);
      assert.equal(deliveries.length, 1, 'missing delivery record');
      const delivery = deliveries[0];
      const originalPolicies = arm === 'strict-fulfilled' ? ["connect-src 'none'", "img-src 'none'"]
        : arm === 'network-fulfilled' ? ["img-src 'none'", env.addedPolicy] : ["img-src 'none'"];
      const policies = headers => headers.filter(h => h.name.toLowerCase() === 'content-security-policy').map(h => h.value);
      assert.deepEqual(policies(delivery.originalHeaders), originalPolicies);
      const addsPolicy = ['added-policy', 'fulfilled-policy', 'strict-fulfilled'].includes(arm);
      assert.deepEqual(delivery.finalHeaders, [...delivery.originalHeaders,
        ...(addsPolicy ? [{ name: 'Content-Security-Policy', value: env.addedPolicy }] : [])], 'replay changed original headers');
      assert.deepEqual(delivery.policies, policies(delivery.finalHeaders));
      assert.equal(delivery.mechanism, arm === 'added-policy' ? 'continueResponse' : 'fulfillRequest');
      if (delivery.mechanism === 'fulfillRequest') {
        assert.ok(delivery.bodyBytes > 0 && delivery.bodyBytes <= 256 * 1024);
        assert.match(delivery.bodySha256, /^[0-9a-f]{64}$/);
      }
    }
    for (const mode of modes) {
      const matches = results.filter(row => row.arm === arm && row.mode === mode);
      assert.equal(matches.length, 1, `${arm}/${mode}: missing or duplicate case`);
      const { result, hits } = matches[0];
      assert.ok(result.http, `${arm}/${mode}: worker did not complete`);
      assert.equal(result.http.aborted, false, `${arm}/${mode}: fetch timed out`);
      assert.notEqual(result.ws, 'timeout');
      assert.notEqual(result.wss, 'timeout');
      assert.deepEqual(hits, finalHits.filter(hit => hit.arm === arm && hit.mode === mode), 'late/missing server hit');
      const violations = result.diagnostics.violations;
      const violationFor = (scheme, policy) => violations.some(v => {
        if (v.effectiveDirective !== 'connect-src' || v.disposition !== 'enforce' ||
          !v.blockedURI.startsWith(`${scheme}://`) || v.originalPolicy !== policy) return false;
        const blocked = new URL(v.blockedURI);
        return blocked.searchParams.get('arm') === arm && blocked.searchParams.get('mode') === mode &&
          blocked.pathname === (scheme === 'http' ? '/probe' : '/socket');
      });
      if (result.http.status === 200) {
        assert.equal(result.http.body, 'worker-http-ok');
        assert.equal(hits.filter(hit => hit.kind === 'http' && hit.method === 'GET').length, 1);
      }
      for (const kind of ['ws', 'wss']) {
        assert.ok(['open', 'error'].includes(result[kind]), 'unclassified socket outcome');
        assert.equal(hits.filter(hit => hit.kind === kind).length, result[kind] === 'open' ? 1 : 0);
        if (['added-policy', 'network-fulfilled', 'fulfilled-policy'].includes(arm) && result[kind] === 'error') {
          assert.ok(violationFor(kind, env.addedPolicy), 'candidate denial lacks CSP evidence');
        }
      }
      if (arm === 'fulfilled-control') assert.deepEqual(violations, [], 'no-policy replay unexpectedly has CSP violations');
      if (arm !== 'strict-fulfilled' && result.http.status !== 200) {
        assert.ok(result.http.error, 'unclassified HTTP failure');
        assert.equal(hits.filter(hit => hit.kind === 'http').length, 0);
        assert.equal(violations.filter(v => /^https?:/.test(v.blockedURI)).length, 0);
        const failures = coverage.paused.filter(row => row.arm === arm && row.mode === mode &&
          row.path === '/probe' && row.stage === 'response' && row.responseErrorReason);
        assert.equal(failures.length, 1, 'missing correlated response failure');
        const failure = failures[0];
        assert.ok(failure.requestId && failure.networkId);
        assert.ok(coverage.paused.some(row => row.arm === arm && row.mode === mode && row.path === '/probe' &&
          row.stage === 'request' && row.requestId === failure.requestId && row.networkId === failure.networkId));
      }
      if (['native-control', 'control', 'native-policy', 'network-policy'].includes(arm)) {
        assert.equal(result.http.status, 200, 'HTTP positive control failed');
        for (const kind of ['ws', 'wss']) {
          if (arm.endsWith('control')) assert.equal(result[kind], 'open');
          else {
            assert.equal(result[kind], 'error');
            assert.ok(violationFor(kind, env.addedPolicy), 'missing CSP denial evidence');
          }
        }
      }
      if (arm === 'strict-fulfilled') {
        assert.deepEqual(hits, []);
        for (const scheme of ['http', 'ws', 'wss']) {
          assert.ok(violationFor(scheme, "connect-src 'none'"), 'strict-policy recorder control failed');
        }
      }
    }
  }
  assert.ok(finalHits.every(hit => arms.includes(hit.arm) && modes.includes(hit.mode)), 'unattributed server hit');
  return {
    fixtureValid: true, securityAcceptance: false, browserVersion: env.browserVersion, cases: results.length,
    nonStrictHttpFailures: results.filter(row => row.arm !== 'strict-fulfilled' && row.result.http.status !== 200)
      .map(row => ({ arm: row.arm, mode: row.mode, error: row.result.http.error })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, 'usage: node scripts/probes/verify-worker-inheritance.mjs evidence.jsonl');
  const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(line => JSON.parse(line));
  console.log(JSON.stringify(verifyInheritanceEvidence(rows)));
}
