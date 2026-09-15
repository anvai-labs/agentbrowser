import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateBrowserEgress, REQUIRED_CHANNELS } from './browser-egress-gate.mjs';
import { handlePublicEgressRequest } from '../packages/engine-firefox/scripts/public-egress-request.mjs';

const expected = { candidate: 'public-interception-v1', driver: '25.11.0', browser: 'Firefox/155.0.1' };
const passing = () => ({
  ...expected,
  channels: REQUIRED_CHANNELS.map(channel => ({ channel, allowedHits: 1, deniedHits: 0, denialCallbacks: 1, allowedCompleted: true, deniedCompleted: true })),
  boundaries: { responseBytesBeforeDelivery: 'verified', dnsConnectionBinding: 'verified', startupBeforeExecution: 'verified', forcedEgress: 'verified' },
});

test('requires every channel and independently established boundary', () => {
  assert.equal(evaluateBrowserEgress(passing(), expected).ready, true);
  const report = passing();
  report.channels.pop();
  assert.equal(evaluateBrowserEgress(report, expected).ready, false);
  report.boundaries.responseBytesBeforeDelivery = 'unsupported';
  assert.ok(evaluateBrowserEgress(report, expected).reasons.includes('responseBytesBeforeDelivery:unsupported'));
});

test('handler callbacks do not compensate for destination traffic', () => {
  const report = passing();
  report.channels[0].deniedHits = 1;
  assert.ok(evaluateBrowserEgress(report, expected).reasons.includes('navigation:destination-reached'));
});

test('zero forbidden hits is insufficient without a working control and completed attempts', () => {
  for (const field of ['allowedHits', 'denialCallbacks', 'allowedCompleted', 'deniedCompleted']) {
    const report = passing();
    report.channels[0][field] = field.endsWith('Completed') ? false : 0;
    assert.equal(evaluateBrowserEgress(report, expected).ready, false, field);
  }
});

test('rejects malformed, duplicate, mismatched-version and unknown-boundary evidence', () => {
  for (const mutate of [
    r => { r.driver = 'different'; },
    r => { r.channels.push(r.channels[0]); },
    r => { r.channels[0].deniedHits = -1; },
    r => { r.channels[0].allowedHits = Number.NaN; },
    r => { r.boundaries.forcedEgress = 'unknown'; },
    r => { delete r.boundaries; },
    r => { r.errors = [{ phase: 'setup', message: 'failed' }]; },
  ]) {
    const report = passing(); mutate(report);
    assert.equal(evaluateBrowserEgress(report, expected).ready, false);
  }
  assert.equal(evaluateBrowserEgress(null, expected).ready, false);
});

test('public probe does not resolve unpaused setup traffic or claim it denied a target', async () => {
  const errors = [], intercepted = new Map();
  const context = { target: 'http://fixture.invalid', deny: true, errors, intercepted };
  const disabled = url => ({
    url: () => url, interceptResolutionState: () => ({ action: 'disabled' }),
    abort: () => assert.fail('Cannot abort an unpaused request'),
    continue: () => assert.fail('Cannot continue an unpaused request'),
  });
  await handlePublicEgressRequest(disabled('about:blank'), context);
  assert.deepEqual(errors, []);
  await handlePublicEgressRequest(disabled('http://fixture.invalid/target/fetch?run=early'), context);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].phase, 'interception');
  assert.equal(intercepted.size, 0);
  const report = passing(); report.errors = errors;
  assert.equal(evaluateBrowserEgress(report, expected).ready, false);
});

test('public probe records only completed aborts and retains resolution failures', async () => {
  const errors = [], intercepted = new Map();
  const context = { target: 'http://fixture.invalid', deny: true, errors, intercepted };
  const request = {
    url: () => 'http://fixture.invalid/target/fetch?run=blocked',
    interceptResolutionState: () => ({ action: 'none' }),
    abort: async () => {}, continue: () => assert.fail('Denied request continued'),
  };
  await handlePublicEgressRequest(request, context);
  assert.equal(intercepted.get('blocked'), 1);
  await handlePublicEgressRequest({ ...request, abort: async () => { throw new Error('transport failed'); } }, context);
  assert.equal(intercepted.get('blocked'), 1);
  assert.deepEqual(errors, [{ phase: 'interception', message: 'transport failed' }]);
});
