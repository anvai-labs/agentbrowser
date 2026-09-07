import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ChildCdp } from './probes/child-cdp.mjs';

const setup = options => {
  const parent = new EventEmitter();
  const sent = [];
  parent.send = async (method, params) => { sent.push({ method, ...params }); };
  return { parent, sent, child: new ChildCdp(parent, 'owned', options) };
};
const reply = (parent, sessionId, message) => parent.emit('Target.receivedMessageFromTarget', { sessionId, message: JSON.stringify(message) });

test('commands and events are scoped to the owned child session', async () => {
  const { parent, child, sent } = setup();
  const result = child.send('Network.enable');
  await Promise.resolve();
  assert.equal(sent[0].sessionId, 'owned');
  reply(parent, 'other', { id: 1, result: { wrong: true } });
  assert.equal(child.pendingCount, 1);
  reply(parent, 'owned', { id: 1, result: { ok: true } });
  assert.deepEqual(await result, { ok: true });
  const events = [];
  child.on('Network.loadingFailed', event => events.push(event));
  reply(parent, 'owned', { method: 'Network.loadingFailed', params: { requestId: 'r1' } });
  assert.deepEqual(events, [{ requestId: 'r1' }]);
  child.close();
});

test('protocol errors and parent-send failures settle the command', async () => {
  const { parent, child } = setup();
  const command = child.send('Network.enable');
  reply(parent, 'owned', { id: 1, error: { message: 'unsupported' } });
  await assert.rejects(command, /unsupported/);
  parent.send = async () => { throw new Error('transport failed'); };
  await assert.rejects(child.send('Network.enable'), /transport failed/);
  assert.equal(child.pendingCount, 0);
  child.close();
});

test('admission and deadlines are bounded', async () => {
  const { child } = setup({ capacity: 1, timeoutMs: 10 });
  const pending = child.send('Network.enable');
  await assert.rejects(child.send('Runtime.enable'), /capacity/);
  await assert.rejects(pending, /timeout/);
  assert.equal(child.pendingCount, 0);
  child.close();
});

test('detach rejects work and removes only owned listeners', async () => {
  const { parent, child } = setup();
  const unrelated = () => {};
  parent.on('Target.receivedMessageFromTarget', unrelated);
  const command = child.send('Network.enable');
  parent.emit('Target.detachedFromTarget', { sessionId: 'owned' });
  await assert.rejects(command, /detached/);
  await assert.rejects(child.send('Network.enable'), /closed/);
  child.close();
  assert.deepEqual(parent.listeners('Target.receivedMessageFromTarget'), [unrelated]);
  assert.equal(parent.listenerCount('Target.detachedFromTarget'), 0);
});

test('malformed messages close the diagnostic session without an uncaught parse error', async () => {
  const { parent, child } = setup();
  const pending = child.send('Network.enable');
  parent.emit('Target.receivedMessageFromTarget', { sessionId: 'owned', message: '{' });
  await assert.rejects(pending, /malformed/);
  assert.equal(child.pendingCount, 0);
});

test('nested sessions route through their owning child and await the inner reply', async () => {
  const { parent, child, sent } = setup();
  const nested = new ChildCdp(child, 'nested');
  const pending = nested.send('Target.setAutoAttach', { autoAttach: true });
  await Promise.resolve();
  await Promise.resolve();
  const outer = JSON.parse(sent[0].message);
  assert.equal(sent[0].sessionId, 'owned');
  assert.equal(outer.method, 'Target.sendMessageToTarget');
  assert.equal(outer.params.sessionId, 'nested');
  assert.equal(JSON.parse(outer.params.message).method, 'Target.setAutoAttach');
  reply(parent, 'owned', { id: outer.id, result: {} });
  assert.equal(nested.pendingCount, 1, 'outer acknowledgement does not settle nested command');
  reply(parent, 'owned', { method: 'Target.receivedMessageFromTarget', params: { sessionId: 'nested', message: JSON.stringify({ id: 1, result: { ok: true } }) } });
  assert.deepEqual(await pending, { ok: true });
  nested.close();
  child.close();
  assert.equal(parent.listenerCount('Target.receivedMessageFromTarget'), 0);
});

test('close before queued dispatch sends nothing and rejects pending work', async () => {
  const { child, sent } = setup();
  const pending = child.send('Runtime.runIfWaitingForDebugger');
  child.close();
  await assert.rejects(pending, /closed/);
  assert.deepEqual(sent, []);
});
