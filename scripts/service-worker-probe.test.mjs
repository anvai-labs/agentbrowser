import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { probeServiceWorker } from '../packages/engine-firefox/scripts/service-worker-probe.mjs';

function fixture() {
  const timers = new Map(); let timerId = 0, unregisters = 0, sends = 0;
  const registration = Promise.withResolvers();
  const ready = Promise.withResolvers();
  const active = new EventTarget(); active.state = 'activating';
  active.postMessage = () => { sends++; };
  const serviceWorker = new EventTarget();
  serviceWorker.register = () => registration.promise; serviceWorker.ready = ready.promise;
  const record = { active, unregister: async () => { unregisters++; } };
  const result = runInNewContext(`(${probeServiceWorker.toString()})({script:'fixture.js'})`, {
    navigator: { serviceWorker },
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const fire = ms => { const timer = [...timers.values()].find(timer => timer.ms === ms); assert.ok(timer); timer.callback(); };
  return { registration, ready, record, active, serviceWorker, result, flush, fire,
    get sends() { return sends; }, get unregisters() { return unregisters; }, timers };
}

test('worker probe waits for activation before starting its outcome deadline and dispatches once', async () => {
  const f = fixture();
  f.registration.resolve(f.record); f.ready.resolve(f.record); await f.flush();
  assert.equal(f.sends, 0);
  assert.deepEqual([...f.timers.values()].map(t => t.ms), [10000]);
  f.active.state = 'activated'; f.active.dispatchEvent(new Event('statechange'));
  f.active.dispatchEvent(new Event('statechange'));
  assert.equal(f.sends, 1);
  assert.deepEqual([...f.timers.values()].map(t => t.ms), [3000]);
  f.serviceWorker.dispatchEvent(new MessageEvent('message', { data: 'reached' }));
  assert.equal(await f.result, 'reached');
  assert.equal(f.unregisters, 1); assert.equal(f.timers.size, 0);
});

test('setup timeout never dispatches after a late registration or activation', async () => {
  const f = fixture(); f.fire(10000);
  assert.equal(await f.result, 'setup-timeout');
  f.registration.resolve(f.record); f.ready.resolve(f.record); await f.flush();
  f.active.state = 'activated'; f.active.dispatchEvent(new Event('statechange'));
  assert.equal(f.sends, 0); assert.equal(f.unregisters, 1);
});

test('missing worker response stays inconclusive and is never retried', async () => {
  const f = fixture(); f.active.state = 'activated';
  f.registration.resolve(f.record); f.ready.resolve(f.record); await f.flush();
  f.fire(3000); assert.equal(await f.result, 'timeout');
  f.active.dispatchEvent(new Event('statechange'));
  assert.equal(f.sends, 1); assert.equal(f.unregisters, 1);
});
