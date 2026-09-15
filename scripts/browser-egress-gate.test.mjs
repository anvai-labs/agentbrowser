import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateBrowserEgress, REQUIRED_CHANNELS } from './browser-egress-gate.mjs';
import { handlePublicEgressRequest, installPublicEgressPage } from '../packages/engine-firefox/scripts/public-egress-request.mjs';

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

test('an unpaused popup disqualifies the candidate with or without a destination hit', async () => {
  const errors = [], intercepted = new Map();
  await handlePublicEgressRequest({
    url: () => 'http://fixture.invalid/target/popup?run=popup-race',
    interceptResolutionState: () => ({ action: 'disabled' }),
    abort: () => assert.fail('Unpaused popup cannot be aborted'),
    continue: () => assert.fail('Unpaused popup cannot be continued'),
  }, { target: 'http://fixture.invalid', deny: true, errors, intercepted });
  assert.deepEqual(errors, [{ phase: 'interception', message: 'Denied request was not paused: /target/popup' }]);
  assert.equal(intercepted.size, 0);
  for (const deniedHits of [0, 1]) {
    const report = passing();
    report.errors = errors;
    Object.assign(report.channels.find(row => row.channel === 'popup'), { deniedHits, denialCallbacks: 0 });
    const gate = evaluateBrowserEgress(report, expected);
    assert.equal(gate.ready, false);
    assert.ok(gate.reasons.includes('probe-errors'));
    assert.ok(gate.reasons.includes('popup:denial-unproven'));
    assert.equal(gate.reasons.includes('popup:destination-reached'), deniedHits > 0);
  }
});

test('closed popup setup remains disqualifying evidence before and during installation', async () => {
  for (const alreadyClosed of [false, true]) {
    const errors = [], intercepted = new Map();
    let closed = alreadyClosed, rejectSetup;
    const page = {
      isClosed: () => closed,
      on: () => assert.equal(alreadyClosed, false),
      setRequestInterception: () => {
        assert.equal(alreadyClosed, false);
        return new Promise((_, reject) => { rejectSetup = reject; });
      },
    };
    const installing = installPublicEgressPage(page, { target: 'http://fixture.invalid', deny: true, errors, intercepted });
    if (!alreadyClosed) {
      closed = true;
      rejectSetup(new Error('Protocol error (network.addIntercept): no such frame Browsing Context with id owned-fixture not found'));
    }
    await installing;
    assert.deepEqual(errors, [{ phase: 'popup-install', reason: 'target-closed', message: 'Target closed before interception setup completed' }]);
    assert.equal(intercepted.size, 0);
    const report = passing(); report.errors = errors;
    const gate = evaluateBrowserEgress(report, expected);
    assert.equal(gate.ready, false);
    assert.ok(gate.reasons.includes('probe-errors'));
  }
});

test('popup installation does not hide live-target or unrelated transport failures', async () => {
  for (const [closed, message] of [
    [false, 'Protocol error (network.addIntercept): no such frame live target'],
    [true, 'unexpected transport failure'],
  ]) {
    const errors = [], intercepted = new Map();
    const failure = new Error(message);
    let started = false;
    const page = {
      isClosed: () => started && closed,
      on: () => {},
      setRequestInterception: async () => { started = true; throw failure; },
    };
    await assert.rejects(installPublicEgressPage(page, { target: 'http://fixture.invalid', deny: true, errors, intercepted }), error => error === failure);
    assert.deepEqual(errors, []); // The owner records the original failure.
    assert.equal(intercepted.size, 0);
  }
});
