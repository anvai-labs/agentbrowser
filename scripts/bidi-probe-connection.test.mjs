import assert from 'node:assert/strict';
import test from 'node:test';
import { BidiProbeConnection } from '../packages/engine-firefox/scripts/bidi-probe-connection.mjs';

class Socket extends EventTarget {
  readyState = 1;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}

test('correlates interleaved events and out-of-order replies without replay', async () => {
  const socket = new Socket(); const connection = new BidiProbeConnection(socket);
  const events = []; connection.onEvent(event => events.push(event));
  const first = connection.send('first'); const second = connection.send('second');
  socket.receive({ type: 'event', method: 'network.beforeRequestSent', params: {} });
  socket.receive({ type: 'success', id: 2, result: { second: true } });
  socket.receive({ type: 'error', id: 1, error: 'invalid argument', message: 'fixture' });
  await assert.rejects(first, /invalid argument/);
  assert.deepEqual(await second, { second: true });
  assert.equal(events.length, 1); assert.equal(socket.sent.length, 2);
  connection.close();
});

test('disconnect rejects outstanding and future commands', async () => {
  const socket = new Socket(); const connection = new BidiProbeConnection(socket);
  const pending = connection.send('mutation'); socket.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(connection.send('mutation'), /closed/);
  assert.equal(socket.sent.length, 1);
});

test('timeout retires the connection and rejects other pending commands', async () => {
  const socket = new Socket(); const connection = new BidiProbeConnection(socket, { timeoutMs: 10 });
  const outcomes = await Promise.allSettled([connection.send('hung'), connection.send('queued')]);
  assert.ok(outcomes.every(result => result.status === 'rejected' && result.reason.name === 'TimeoutError'));
  await assert.rejects(connection.send('late'), /closed/);
  assert.equal(socket.sent.length, 2);
});

test('pending command saturation refuses before sending', async () => {
  const socket = new Socket(); const connection = new BidiProbeConnection(socket, { maxPending: 1 });
  const pending = connection.send('first');
  await assert.rejects(connection.send('excess'), /capacity/);
  socket.receive({ type: 'success', id: 1, result: {} }); await pending;
  assert.equal(socket.sent.length, 1); connection.close();
});

test('malformed messages retire the connection rather than hanging a command', async () => {
  const socket = new Socket(); const connection = new BidiProbeConnection(socket);
  const pending = connection.send('first');
  socket.dispatchEvent(new MessageEvent('message', { data: '{' }));
  await assert.rejects(pending, /Malformed/);
  await assert.rejects(connection.send('late'), /closed/);
});
