import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeWorker } from './probes/owner-release.mjs';

test('setup failure aborts without a release command', async () => {
  const sent = [];
  let aborted = false;
  await assert.rejects(initializeWorker({
    send: async method => { sent.push(method); throw new Error('setup failure'); },
    abort: async () => { aborted = true; }, holdMs: 0,
  }), /setup failure/);
  assert.deepEqual(sent, ['Target.setAutoAttach']);
  assert.equal(aborted, true);
});
test('disconnect during delay cancels release and aborts the target', async () => {
  const controller = new AbortController();
  const sent = [];
  let aborted = false;
  await assert.rejects(initializeWorker({
    send: async method => { sent.push(method); controller.abort(); },
    abort: async () => { aborted = true; }, signal: controller.signal, holdMs: 200,
  }), /abort/i);
  assert.deepEqual(sent, ['Target.setAutoAttach']);
  assert.equal(aborted, true);
});
test('immediate control sets up recursion before release', async () => {
  const sent = [];
  await initializeWorker({ send: async method => { sent.push(method); }, abort: async () => { throw new Error('unexpected abort'); }, holdMs: 0 });
  assert.deepEqual(sent, ['Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
});
