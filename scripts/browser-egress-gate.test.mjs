import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateBrowserEgress, REQUIRED_CHANNELS } from './browser-egress-gate.mjs';

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
