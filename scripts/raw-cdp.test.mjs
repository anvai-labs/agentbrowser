import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RawCdp } from './probes/raw-cdp.mjs';

class Socket extends EventTarget {
  readyState = 1;
  sent = [];
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  reply(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
test('flat commands use connection-global IDs and validate response session identity', async () => {
  const socket = new Socket();
  const cdp = new RawCdp(socket);
  const a = cdp.send('Runtime.enable', {}, 'a');
  const b = cdp.send('Runtime.enable', {}, 'b');
  assert.deepEqual(socket.sent.map(item => [item.id, item.sessionId]), [[1, 'a'], [2, 'b']]);
  socket.reply({ id: 1, sessionId: 'b', result: {} });
  assert.equal(cdp.pendingCount, 2);
  socket.reply({ id: 1, sessionId: 'a', result: { ok: 1 } });
  socket.reply({ id: 2, sessionId: 'b', result: { ok: 2 } });
  assert.deepEqual(await Promise.all([a, b]), [{ ok: 1 }, { ok: 2 }]);
  cdp.close();
});
test('disconnect rejects commands and prevents further dispatch', async () => {
  const socket = new Socket();
  const cdp = new RawCdp(socket);
  const pending = cdp.send('Runtime.enable');
  socket.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(cdp.send('Runtime.enable'), /closed/);
  assert.equal(socket.sent.length, 1);
  assert.equal(cdp.pendingCount, 0);
});
test('capacity, deadline and malformed inbound data are bounded', async () => {
  const socket = new Socket();
  const cdp = new RawCdp(socket, { capacity: 1, timeoutMs: 10 });
  const pending = cdp.send('Runtime.enable');
  await assert.rejects(cdp.send('Runtime.enable'), /capacity/);
  await assert.rejects(pending, /timeout/);
  const malformed = cdp.send('Runtime.enable');
  socket.dispatchEvent(new MessageEvent('message', { data: '{' }));
  await assert.rejects(malformed, /malformed/);
  assert.equal(cdp.pendingCount, 0);
});
test('detach rejects only work for the detached session', async () => {
  const socket = new Socket();
  const cdp = new RawCdp(socket);
  const pending = cdp.send('Runtime.enable', {}, 'child');
  socket.reply({ method: 'Target.detachedFromTarget', params: { sessionId: 'child' }, sessionId: 'parent' });
  await assert.rejects(pending, /detached/);
  await assert.rejects(cdp.send('Runtime.enable', {}, 'child'), /detached/);
  const root = cdp.send('Browser.getVersion');
  socket.reply({ id: 2, result: { product: 'test' } });
  assert.equal((await root).product, 'test');
  cdp.close();
});

for (const input of [null, 5, [], {}, { method: 'Target.detachedFromTarget', params: {} }, { method: 'Target.attachedToTarget', params: { sessionId: 's' } }]) {
  test(`malformed envelope closes safely: ${JSON.stringify(input)}`, async () => {
    const socket = new Socket();
    const cdp = new RawCdp(socket, { timeoutMs: 20 });
    const pending = cdp.send('Runtime.enable');
    socket.reply(input);
    await assert.rejects(pending, /malformed/);
    assert.equal(cdp.pendingCount, 0);
  });
}

test('send failure and protocol error reject without retaining timers', async () => {
  const socket = new Socket();
  const cdp = new RawCdp(socket);
  const pending = cdp.send('Runtime.enable');
  socket.reply({ id: 1, error: { message: 'unsupported' } });
  await assert.rejects(pending, /unsupported/);
  socket.send = () => { throw new Error('send failed'); };
  await assert.rejects(cdp.send('Runtime.enable'), /send failed/);
  assert.equal(cdp.pendingCount, 0);
  cdp.close();
});

test('owned closure preserves unrelated socket listeners', () => {
  const socket = new Socket();
  const cdp = new RawCdp(socket);
  let calls = 0;
  socket.addEventListener('message', () => { calls++; });
  cdp.close();
  socket.reply({ method: 'Runtime.test', params: {} });
  assert.equal(calls, 1);
  assert.equal(cdp.closed, true);
});
