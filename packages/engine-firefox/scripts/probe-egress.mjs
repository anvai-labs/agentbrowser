import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { launch } from 'puppeteer-core';
import { firefoxExecutable } from './browser-config.mjs';
import { evaluateBrowserEgress, REQUIRED_CHANNELS } from '../../../scripts/browser-egress-gate.mjs';

export const EXPECTED_CANDIDATE = Object.freeze({ candidate: 'public-interception-v1', driver: '25.11.0', browser: 'firefox/155.0.1' });

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

/** Feasibility probe only. Deliberately never installed into the production adapter. */
export async function probeFirefoxEgress(executablePath = firefoxExecutable()) {
  const hits = new Map();
  const sockets = new Set();
  const recordHit = url => {
    const key = url.searchParams.get('run');
    hits.set(key, (hits.get(key) ?? 0) + 1);
  };
  const destination = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    if (url.pathname.startsWith('/target/')) recordHit(url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Allowed destination</title>accepted<script>opener?.postMessage(${JSON.stringify(url.searchParams.get('run'))}, '*')</script>`);
  });
  destination.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    recordHit(new URL(req.url, 'http://fixture.invalid'));
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', () => socket.end(Buffer.from([0x88, 0])));
  });
  let target;
  const fixture = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const run = url.searchParams.get('run');
    const channel = url.searchParams.get('channel');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname.startsWith('/redirect')) {
      res.writeHead(302, { Location: url.pathname === '/redirect' ? `/redirect-middle?run=${run}` : `${target}/target/redirect?run=${run}` });
      res.end(); return;
    }
    if (url.pathname === '/worker.js') {
      const fetcher = `fetch(${JSON.stringify(`${target}/target/${channel}?run=${run}`)}).then(() => 'reached', () => 'blocked')`;
      res.setHeader('Content-Type', 'application/javascript');
      res.end(channel === 'dedicated-worker' ? `${fetcher}.then(value => postMessage(value));`
        : channel === 'shared-worker' ? `onconnect = e => { ${fetcher}.then(value => e.ports[0].postMessage(value)); };`
        : `self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(clients.claim())); self.addEventListener('message', e => e.waitUntil(${fetcher}.then(value => e.source.postMessage(value))));`);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    if (url.pathname === '/large') {
      // No Content-Length: a header-only gate cannot prove an actual-byte cap.
      res.write('<!doctype html><body>'); res.end('x'.repeat(65536)); return;
    }
    res.end('<!doctype html><title>Egress fixture</title><body>ready');
  });
  const rows = new Map(REQUIRED_CHANNELS.map(channel => [channel, { channel, allowedHits: 0, deniedHits: 0, denialCallbacks: 0, allowedCompleted: false, deniedCompleted: false }]));
  const errors = [];
  const versions = [];
  let responseInspection;
  try {
    target = await listen(destination);
    const origin = await listen(fixture);
    for (const deny of [false, true]) {
      const browser = await launch({ browser: 'firefox', protocol: 'webDriverBiDi', executablePath, headless: true, args: ['--no-remote'] });
      versions.push((await browser.version()).toLowerCase());
      const installed = new WeakMap();
      const installs = new Set();
      const intercepted = new Map();
      const install = page => {
        if (installed.has(page)) return installed.get(page);
        page.on('request', request => {
          const url = new URL(request.url());
          const block = deny && url.origin === target && url.pathname.startsWith('/target/');
          if (block) {
            const key = url.searchParams.get('run');
            intercepted.set(key, (intercepted.get(key) ?? 0) + 1);
          }
          const completion = block ? request.abort('blockedbyclient') : request.continue();
          completion.catch(error => errors.push({ phase: 'interception', message: error.message }));
        });
        const pending = page.setRequestInterception(true);
        installed.set(page, pending);
        installs.add(pending);
        pending.then(() => installs.delete(pending), () => installs.delete(pending));
        return pending;
      };
      const onTarget = target => {
        if (target.type() !== 'page') return;
        // Firefox exposes frame targets as type=page too. Enumerate canonical
        // top-level pages rather than constructing a new page facade for a frame.
        const pending = browser.pages().then(pages => Promise.all(pages.map(install)));
        installs.add(pending);
        pending.then(() => installs.delete(pending), error => {
          installs.delete(pending); errors.push({ phase: 'popup-install', message: error.message });
        });
      };
      browser.on('targetcreated', onTarget);
      const runs = [];
      try {
        for (const channel of REQUIRED_CHANNELS) {
          const run = randomUUID();
          const row = rows.get(channel);
          const page = await browser.newPage();
          await install(page);
          page.setDefaultTimeout(5000);
          let outcome;
          try {
            if (channel === 'navigation' || channel === 'redirect') {
              await page.goto(channel === 'redirect' ? `${origin}/redirect?run=${run}` : `${target}/target/navigation?run=${run}`, { timeout: 5000 });
              outcome = 'reached';
            } else {
              await page.goto(origin, { timeout: 5000 });
              outcome = await page.evaluate(async ({ origin, target, channel, run }) => {
                const url = `${target}/target/${channel}?run=${run}`;
                if (channel === 'fetch') return fetch(url).then(() => 'reached', () => 'blocked');
                return new Promise(resolve => {
                  const cleanups = [];
                  const timer = setTimeout(() => finish('timeout'), 3000);
                  function finish(value) { clearTimeout(timer); for (const cleanup of cleanups) cleanup(); resolve(value); }
                  if (channel === 'frame') {
                    const frame = document.createElement('iframe');
                    frame.onload = () => finish('finished'); frame.onerror = () => finish('blocked');
                    frame.src = url; cleanups.push(() => frame.remove()); document.body.append(frame);
                  } else if (channel === 'websocket') {
                    const ws = new WebSocket(url.replace('http:', 'ws:'));
                    ws.onopen = () => finish('reached'); ws.onerror = () => finish('blocked');
                    cleanups.push(() => ws.close());
                  } else if (channel === 'popup') {
                    const listener = event => { if (event.origin === target && event.data === run) finish('reached'); };
                    window.addEventListener('message', listener);
                    const popup = window.open(url);
                    cleanups.push(() => { window.removeEventListener('message', listener); popup?.close(); });
                  } else {
                    const script = `${origin}/worker.js?channel=${channel}&run=${run}`;
                    if (channel === 'dedicated-worker') {
                      const worker = new Worker(script);
                      worker.onmessage = event => finish(event.data); worker.onerror = () => finish('worker-error');
                      cleanups.push(() => worker.terminate());
                    } else if (channel === 'shared-worker') {
                      const worker = new SharedWorker(script);
                      worker.port.onmessage = event => finish(event.data); worker.onerror = () => finish('worker-error');
                      worker.port.start(); cleanups.push(() => worker.port.close());
                    } else {
                      const listener = event => finish(event.data);
                      navigator.serviceWorker.addEventListener('message', listener);
                      cleanups.push(() => navigator.serviceWorker.removeEventListener('message', listener));
                      navigator.serviceWorker.register(script).then(async registration => {
                        cleanups.push(() => { void registration.unregister(); });
                        await navigator.serviceWorker.ready;
                        registration.active.postMessage('probe');
                      }).catch(() => finish('worker-error'));
                    }
                  }
                });
              }, { origin, target, channel, run });
            }
          } catch (error) {
            outcome = error.name === 'TimeoutError' ? 'timeout' : 'blocked';
            if (!deny) errors.push({ phase: `${channel}-control`, message: error.message });
          } finally { await page.close(); }
          runs.push({ run, row, outcome });
        }
        if (!deny) {
          const page = await browser.newPage(); await install(page);
          const response = await page.goto(`${origin}/large`, { timeout: 5000 });
          let contentError;
          try { await response.content(); } catch (error) { contentError = error.message; }
          responseInspection = { contentAvailable: !contentError, ...(contentError ? { contentError } : {}), deliveredBodyCharacters: await page.evaluate(() => document.body.textContent.length) };
          await page.close();
        }
      } finally {
        browser.off('targetcreated', onTarget);
        await browser.close();
        await Promise.allSettled([...installs]);
      }
      // Browser is closed before counters are frozen: no surviving target can add late hits.
      for (const { run, row, outcome } of runs) {
        row[deny ? 'deniedHits' : 'allowedHits'] = hits.get(run) ?? 0;
        row[deny ? 'deniedCompleted' : 'allowedCompleted'] = (deny ? ['reached', 'blocked', 'finished'] : ['reached', 'finished']).includes(outcome);
        row[deny ? 'deniedOutcome' : 'allowedOutcome'] = outcome;
        if (deny) row.denialCallbacks = intercepted.get(run) ?? 0;
      }
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([close(fixture), close(destination)]);
  }
  const report = {
    candidate: EXPECTED_CANDIDATE.candidate,
    driver: createRequire(import.meta.url)('puppeteer-core/package.json').version,
    browser: versions[0], versions,
    channels: [...rows.values()], responseInspection, errors,
    boundaries: {
      responseBytesBeforeDelivery: responseInspection?.contentAvailable ? 'unverified' : 'unsupported',
      dnsConnectionBinding: 'unverified', startupBeforeExecution: 'unverified', forcedEgress: 'unverified',
    },
  };
  return { ...report, gate: evaluateBrowserEgress(report, EXPECTED_CANDIDATE) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await probeFirefoxEgress();
  console.log(JSON.stringify(report, null, 2));
  // A blocked gate must not look like successful service qualification.
  if (!report.gate.ready) process.exitCode = 1;
}
