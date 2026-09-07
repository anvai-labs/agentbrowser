import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupStartup } from './probes/startup-cleanup.mjs';

const resources = () => {
  const calls = [];
  const sockets = new Set();
  const socket = { destroy() { calls.push('socket'); sockets.delete(socket); } };
  sockets.add(socket);
  return { calls, sockets,
    browser: { async close() { calls.push('browser'); }, isConnected: () => false },
    browserServer: { async close() { calls.push('process'); }, async kill() { calls.push('kill'); } },
    server: { listening: true, close(callback) { calls.push('server'); this.listening = false; callback(); } },
  };
};

test('browser-close rejection still closes the process, sockets and server', async () => {
  const input = resources();
  input.browser.close = async () => { throw new Error('browser failure'); };
  const result = await cleanupStartup(input);
  assert.deepEqual(input.calls, ['process', 'socket', 'server']);
  assert.match(result.errors[0], /browser failure/);
  assert.equal(result.sockets, 0);
  assert.equal(result.serverClosed, true);
});

test('browser-process close timeout uses kill and still closes HTTP resources', async () => {
  const input = resources();
  input.browserServer.close = () => new Promise(() => {});
  const result = await cleanupStartup({ ...input, timeoutMs: 10 });
  assert.deepEqual(input.calls, ['browser', 'kill', 'socket', 'server']);
  assert.match(result.errors[0], /timeout/);
});

test('kill rejection does not skip owned HTTP cleanup', async () => {
  const input = resources();
  input.browserServer.close = async () => { throw new Error('process failure'); };
  input.browserServer.kill = async () => { throw new Error('kill failure'); };
  const result = await cleanupStartup(input);
  assert.deepEqual(input.calls, ['browser', 'socket', 'server']);
  assert.equal(result.errors.length, 2);
  assert.equal(result.serverClosed, true);
});
