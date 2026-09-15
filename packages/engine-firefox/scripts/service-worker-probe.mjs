/** Self-contained owned fixture function, serialized into either browser controller. */
export function probeServiceWorker({ script }) {
  return new Promise(resolve => {
    let finished = false, dispatched = false, registration;
    const cleanups = [];
    let timer = setTimeout(() => finish('setup-timeout'), 10000);
    function finish(value) {
      if (finished) return;
      finished = true; clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
      if (registration) void registration.unregister().catch(() => {});
      resolve(value);
    }
    const listener = event => finish(event.data);
    navigator.serviceWorker.addEventListener('message', listener);
    cleanups.push(() => navigator.serviceWorker.removeEventListener('message', listener));
    navigator.serviceWorker.register(script).then(async created => {
      if (finished) { await created.unregister(); return; }
      registration = created;
      const ready = await navigator.serviceWorker.ready;
      if (finished) return;
      const worker = ready.active;
      if (!worker) { finish('worker-error'); return; }
      const dispatch = () => {
        if (finished || dispatched || worker.state !== 'activated') return;
        dispatched = true;
        clearTimeout(timer); timer = setTimeout(() => finish('timeout'), 3000);
        worker.postMessage('probe');
      };
      worker.addEventListener('statechange', dispatch);
      cleanups.push(() => worker.removeEventListener('statechange', dispatch));
      dispatch();
    }).catch(() => finish('worker-error'));
  });
}
