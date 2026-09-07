// Evidence integrity only. No absence-of-hit observation certifies enforcement.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const one = (items, label) => { assert.equal(items.length, 1, label); return items[0]; };
const ARMS = ['immediate', 'delayed', 'competitor'];
const MODES = ['external-dedicated', 'nested-external'];

export function verifySoleOwner(rows) {
  const environment = one(rows.filter(row => row.kind === 'environment'), 'environment');
  assert.equal(environment.probe, 'sole-owner');
  assert.equal(environment.playwrightConnected, false);
  assert.equal(environment.nativeDelivery, true);
  assert.equal(environment.securityAcceptance, false);
  assert.equal(environment.repeats, 3);
  assert(environment.instrumentation === undefined || environment.instrumentation === 2);
  assert.deepEqual(environment.launchArgs, ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=<owned-temporary-profile>', 'about:blank']);
  const cases = rows.filter(row => row.kind === 'case');
  assert.equal(cases.length, 18);
  const outcomes = [];
  for (const arm of ARMS) for (let repeat = 1; repeat <= 3; repeat++) for (const mode of MODES) {
    const row = one(cases.filter(row => row.arm === arm && row.repeat === repeat && row.mode === mode), 'matrix cell');
    assert.deepEqual(row.errors, []);
    const owners = arm === 'competitor' ? ['primary', 'competitor'] : ['primary'];
    assert.deepEqual(row.cleanup, { pending: 0, tasks: 0, contextClosed: true, connections: owners.length,
      ...(environment.instrumentation === 2 ? { closedConnections: owners.length, listeners: 0 } : {}) });
    const count = mode === 'nested-external' ? 2 : 1;
    assert.equal(row.workers.length, count);
    assert.equal(row.results.length, count);
    assert.equal(new Set(row.workers.map(worker => worker.url)).size, count);
    assert(row.events.length < 200);
    for (let index = 0; index < row.events.length; index++) {
      const event = row.events[index];
      assert(Number.isFinite(event.at) && event.at >= 0);
      if (index) assert(event.at >= row.events[index - 1].at, 'monotonic trace');
      assert(['command-send', 'command-ack', 'page-session', 'attached', 'detached', 'script-request', 'hit', 'launch'].includes(event.kind));
      if (!['launch', 'hit', 'script-request'].includes(event.kind)) assert(owners.includes(event.owner), 'owned event');
    }
    const launch = one(row.events.filter(event => event.kind === 'launch'), 'launch');
    const sends = row.events.filter(event => event.kind === 'command-send');
    const acknowledgements = row.events.filter(event => event.kind === 'command-ack');
    assert.equal(sends.length, acknowledgements.length);
    assert.equal(new Set(sends.map(event => `${event.owner}/${event.commandId}`)).size, sends.length);
    for (const command of sends) {
      assert(['Browser.getVersion', 'Target.createBrowserContext', 'Target.createTarget', 'Target.attachToTarget', 'Target.setAutoAttach', 'Page.enable', 'Page.navigate', 'Runtime.evaluate', 'Runtime.runIfWaitingForDebugger', 'Target.disposeBrowserContext'].includes(command.method), 'native diagnostic commands only');
      if (environment.instrumentation === 2 && command.method === 'Target.setAutoAttach') assert.deepEqual(command.parameters, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'worker', exclude: false }, { exclude: true }] });
      const ack = one(acknowledgements.filter(event => event.owner === command.owner && event.commandId === command.commandId), 'command acknowledgement');
      assert.equal(ack.sessionId, command.sessionId);
      assert.equal(ack.method, command.method);
      assert(ack.at >= command.at);
    }
    const command = (owner, sessionId, method, kind = 'command-send') => one(row.events.filter(event => event.kind === kind && event.owner === owner && event.sessionId === sessionId && event.method === method), method);
    const attached = row.events.filter(event => event.kind === 'attached');
    assert.equal(attached.length, count * owners.length);
    assert.equal(row.events.filter(event => event.kind === 'page-session').length, owners.length);
    assert.equal(row.events.filter(event => event.kind === 'hit').length, count);
    assert.equal(row.events.filter(event => event.kind === 'script-request').length, count);
    for (const owner of owners) {
      const page = one(row.events.filter(event => event.kind === 'page-session' && event.owner === owner), 'page session');
      assert(command(owner, page.sessionId, 'Target.setAutoAttach', 'command-ack').at <= launch.at);
      assert.equal(new Set(attached.filter(event => event.owner === owner).map(event => event.sessionId)).size, count);
      assert.equal(new Set(attached.filter(event => event.owner === owner).map(event => event.targetId)).size, count);
    }
    row.workers.forEach((worker, index) => {
      const token = `${arm}/${repeat}/${mode}/${index + 1}`;
      assert.equal(worker.token, token);
      assert.equal(worker.parentToken, index ? row.workers[index - 1].token : null);
      const url = new URL(worker.url);
      assert.equal(url.hostname, '127.0.0.1');
      assert.equal(url.pathname, `/worker/${token}.js`);
      const result = one(row.results.filter(item => item.token === token), 'positive control');
      assert.equal(result.status, 200);
      assert.equal(result.body, 'worker-startup-ok');
      const hit = one(row.events.filter(event => event.kind === 'hit' && event.token === token), 'server hit');
      assert.equal(hit.method, 'GET');
      const script = one(row.events.filter(event => event.kind === 'script-request' && event.token === token), 'initial script request');
      assert(script.at >= launch.at && hit.at >= script.at);
      const observations = [];
      for (const owner of owners) {
        const attachment = one(attached.filter(event => event.owner === owner && event.url === worker.url), 'worker attachment');
        assert.equal(attachment.depth, index + 1);
        assert.equal(typeof attachment.waitingForDebugger, 'boolean');
        const parent = index
          ? one(attached.filter(event => event.owner === owner && event.url === row.workers[index - 1].url), 'parent worker')
          : one(row.events.filter(event => event.kind === 'page-session' && event.owner === owner), 'parent page');
        assert.equal(attachment.parentSessionId, parent.sessionId);
        assert(attachment.at >= launch.at && attachment.at >= parent.at);
        const setup = command(owner, attachment.sessionId, 'Target.setAutoAttach');
        const setupAck = command(owner, attachment.sessionId, 'Target.setAutoAttach', 'command-ack');
        const release = command(owner, attachment.sessionId, 'Runtime.runIfWaitingForDebugger');
        assert(setup.at >= attachment.at && setupAck.at <= release.at);
        if (owner === 'primary' && arm !== 'immediate') assert(release.at - setupAck.at >= 198, '200ms hold with 2ms timer tolerance');
        observations.push({ owner, targetId: attachment.targetId, releaseAt: release.at,
          waitingForDebugger: attachment.waitingForDebugger, lateAttachment: hit.at < attachment.at,
          hitMinusReleaseMs: hit.at - release.at, scriptBeforeRelease: script.at < release.at });
      }
      if (owners.length === 2) assert.equal(observations[0].targetId, observations[1].targetId, 'cross-owner same target');
      outcomes.push({ token, classification: hit.at < observations[0].releaseAt ? 'preReleaseExecutionObserved' : 'noPreReleaseHitObserved',
        ...(owners.length === 2 ? { competitorReleasedBeforePrimary: observations[1].releaseAt < observations[0].releaseAt, competitorLeadMs: observations[0].releaseAt - observations[1].releaseAt } : {}), observations });
    });
  }
  const cleanup = one(rows.filter(row => row.kind === 'cleanup'), 'cleanup');
  assert.deepEqual(cleanup, { kind: 'cleanup', processExited: true, sockets: 0, serverClosed: true, profileRemoved: true, errors: [] });
  assert.equal(rows.length, 20);
  return { fixtureValid: true, securityAcceptance: false, completePreExecutionCoverage: false, outcomes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(verifySoleOwner(readFileSync(process.argv[2] ?? 'docs/evidence/sole-owner.jsonl', 'utf8').trim().split('\n').map(JSON.parse)), null, 2));
}
