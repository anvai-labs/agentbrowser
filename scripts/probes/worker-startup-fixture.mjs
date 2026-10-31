// Shared serialized fixture, mechanically extracted from the retained T1b probe.
// Fetch starts before child creation; neither awaits the other's network result.
export function executeWorker(config) {
  const own = fetch(config.sentinel, { signal: AbortSignal.timeout(3000) })
    .then(async response => ({ token: config.token, status: response.status, body: await response.text() }))
    .catch(error => ({ token: config.token, error: String(error) }));
  let descendant = Promise.resolve({ workers: [], results: [] });
  if (config.child) {
    const childUrl = config.child.url ?? URL.createObjectURL(new Blob([config.child.source], { type: 'text/javascript' }));
    const child = new Worker(childUrl);
    descendant = new Promise(resolve => {
      child.onmessage = event => resolve({ workers: [{ token: config.child.token, parentToken: config.token, url: childUrl }, ...event.data.workers], results: event.data.results });
      child.onerror = event => resolve({ workers: [], results: [{ token: config.child.token, error: event.message }] });
    });
  }
  const result = Promise.all([own, descendant]).then(([selfResult, nested]) => ({ workers: nested.workers, results: [selfResult, ...nested.results] }));
  if (config.shared) self.onconnect = event => { result.then(value => event.ports[0].postMessage(value)); };
  else result.then(value => self.postMessage(value));
}
