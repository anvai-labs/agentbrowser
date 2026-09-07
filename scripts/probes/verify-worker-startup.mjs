// Fixture integrity and causal classification, never an enforcement acceptance gate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ARMS = ['native-control', 'nonrecursive', 'recursive'];
export const MODES = ['external-dedicated', 'blob-dedicated', 'data-dedicated', 'nested-external', 'nested-blob', 'external-shared', 'blob-shared'];
const one = (items, message) => { assert.equal(items.length, 1, message); return items[0]; };

export function verifyStartupCase(row) {
  assert(ARMS.includes(row.arm) && MODES.includes(row.mode));
  assert.equal(row.holdMs, 200);
  assert.deepEqual(row.errors, []);
  assert.deepEqual(row.cleanup, { pending: 0, tasks: 0, listeners: 0, contextClosed: true });
  const count = row.mode.startsWith('nested-') ? 2 : 1;
  assert.equal(row.workers.length, count);
  assert.equal(row.results.length, count);
  assert.equal(new Set(row.workers.map(worker => worker.urlKey)).size, count);
  const events = row.events;
  assert(events.length < 100);
  for (let i = 0; i < events.length; i++) {
    assert(Number.isFinite(events[i].at) && events[i].at >= 0);
    if (i) assert(events[i].at >= events[i - 1].at, 'monotonic event ordering');
    assert(['root-setup', 'launch', 'attached', 'recursive-setup', 'hit', 'release-dispatch', 'release-ack', 'detached'].includes(events[i].kind));
    if (!['root-setup', 'launch', 'hit'].includes(events[i].kind)) assert.equal(typeof events[i].sessionId, 'string', 'session event identity');
  }
  const launch = one(events.filter(event => event.kind === 'launch'), 'one launch');
  const attachments = events.filter(event => event.kind === 'attached');
  assert.equal(new Set(attachments.map(event => event.sessionId)).size, attachments.length);
  assert.equal(new Set(attachments.map(event => event.targetId)).size, attachments.length);
  for (const attachment of attachments) {
    one(row.workers.filter(worker => worker.urlKey === attachment.urlKey), 'owned attachment URL');
    assert.equal(attachment.targetType, 'worker');
    assert.equal(typeof attachment.waitingForDebugger, 'boolean');
    assert(attachment.at >= launch.at);
  }
  if (row.arm === 'native-control') {
    assert.equal(attachments.length, 0);
    assert.equal(events.filter(event => event.kind === 'root-setup').length, 0);
  } else {
    assert(one(events.filter(event => event.kind === 'root-setup'), 'root setup').at <= launch.at);
  }
  for (const event of events.filter(event => event.sessionId && event.kind !== 'attached')) {
    assert(attachments.some(attachment => attachment.sessionId === event.sessionId), 'owned session event');
  }
  assert.equal(events.filter(event => event.kind === 'hit').length, count);
  return row.workers.map((worker, index) => {
    const token = `${row.arm}/${row.mode}/${index + 1}`;
    assert.equal(worker.token, token);
    assert.equal(worker.parentToken, index ? row.workers[index - 1].token : null);
    const result = one(row.results.filter(item => item.token === token), 'one positive result');
    assert.equal(result.status, 200);
    assert.equal(result.body, 'worker-startup-ok');
    const hit = one(events.filter(event => event.kind === 'hit' && event.token === token), 'one server hit');
    assert.equal(hit.method, 'GET');
    assert(hit.at >= launch.at);
    const attached = attachments.filter(event => event.urlKey === worker.urlKey);
    assert(attached.length <= 1);
    if (!attached.length) return { token, classification: row.arm === 'native-control' ? 'nativeControl' : 'uncoveredTarget' };
    const attachment = attached[0];
    const parent = worker.parentToken && attachments.find(event => event.urlKey === row.workers[index - 1].urlKey);
    assert.equal(attachment.parentSessionId, parent ? parent.sessionId : null, 'target lineage');
    if (index) assert.equal(row.arm, 'recursive');
    const sessionEvents = events.filter(event => event.sessionId === attachment.sessionId);
    const release = one(sessionEvents.filter(event => event.kind === 'release-dispatch'), 'release dispatch');
    const ack = one(sessionEvents.filter(event => event.kind === 'release-ack'), 'release acknowledgement');
    assert(release.at - attachment.at >= row.holdMs - 2, 'minimum observed hold (timer tolerance 2ms)');
    assert(ack.at >= release.at);
    const setup = sessionEvents.filter(event => event.kind === 'recursive-setup');
    if (row.arm === 'recursive') {
      const enabled = one(setup, 'recursive setup');
      assert(enabled.at >= attachment.at && enabled.at <= release.at);
    } else assert.equal(setup.length, 0);
    return { token, waitingForDebugger: attachment.waitingForDebugger,
      lateAttachment: hit.at < attachment.at, hitMinusReleaseMs: hit.at - release.at,
      classification: hit.at < release.at ? 'preReleaseExecutionObserved' : 'noPreReleaseHitWithinWindow' };
  });
}

export function verifyStartup(rows) {
  const env = one(rows.filter(row => row.kind === 'environment'), 'environment');
  assert.equal(env.probe, 'worker-startup');
  assert.equal(env.securityAcceptance, false);
  assert.equal(env.holdMs, 200);
  assert.equal(env.nativeDelivery, true);
  const cases = rows.filter(row => row.kind === 'case');
  assert.equal(cases.length, ARMS.length * MODES.length);
  const outcomes = [];
  for (const arm of ARMS) for (const mode of MODES) {
    outcomes.push(...verifyStartupCase(one(cases.filter(row => row.arm === arm && row.mode === mode), `${arm}/${mode}`)));
  }
  const cleanup = one(rows.filter(row => row.kind === 'cleanup'), 'cleanup');
  // Initial capture predates the reviewed failure-path cleanup instrumentation.
  assert.deepEqual(cleanup.errors ?? [], []);
  assert.equal(cleanup.browserClosed, true);
  assert.equal(cleanup.sockets, 0);
  assert.equal(cleanup.serverClosed, true);
  assert.equal(rows.length, cases.length + 2);
  return { fixtureValid: true, securityAcceptance: false, completePreExecutionCoverage: false, outcomes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = readFileSync(process.argv[2] ?? 'docs/evidence/worker-startup.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
  console.log(JSON.stringify(verifyStartup(rows), null, 2));
}
