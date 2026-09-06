// T1 feasibility probe only, not production enforcement or a security acceptance test.
// Run from a dependency-installed checkout: node scripts/probes/worker-csp.mjs
// Requires OpenSSL and the pinned Playwright Chromium binary. Exit 0 means execution completed,
// not that enforcement passed. Inspect result/hits, handlerErrors and cleanup records.
// One owned browser, 90-second execution deadline and bounded cleanup.
// Certificates exist only in memory. Certificate-error bypass is fixture-browser-only.
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from '../../packages/engine-playwright/node_modules/playwright/index.mjs';

const MODES = ['external-dedicated', 'external-shared', 'nested-external', 'blob-dedicated', 'blob-shared', 'data-dedicated', 'nested-blob'];
const addedPolicy = 'connect-src http: https:';
const hits = [];
const sockets = new Set();
const paused = [];
const injected = [];
const handlerErrors = [];
const results = [];
let browserServer;
let browser;
let plain;
let tls;
let deadline;

// This function is serialized into external, blob and data worker scripts.
async function runChecks(config) {
  const fetchController = new AbortController();
  const fetchTimer = setTimeout(() => fetchController.abort(), 1500);
  let http;
  try {
    const response = await fetch(config.http, { signal: fetchController.signal });
    http = { status: response.status, body: await response.text() };
  } catch (error) {
    http = { error: String(error) };
  } finally {
    clearTimeout(fetchTimer);
  }
  const socketCheck = endpoint => new Promise(resolve => {
    let ws;
    let done = false;
    const finish = outcome => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('timeout'), 1500);
    try {
      ws = new WebSocket(endpoint);
      ws.onopen = () => finish('open');
      ws.onerror = () => finish('error');
      ws.onclose = event => finish('closed:' + event.code);
    } catch (error) {
      finish('throw:' + String(error));
    }
  });
  return { http, ws: await socketCheck(config.ws), wss: await socketCheck(config.wss) };
}

const workerSource = (config, shared = false) => {
  const execute = `(${runChecks.toString()})(${JSON.stringify(config)})`;
  return shared
    ? `self.onconnect=event=>{const port=event.ports[0];${execute}.then(result=>{port.postMessage(result);setTimeout(()=>self.close(),10);});};`
    : `${execute}.then(result=>{self.postMessage(result);setTimeout(()=>self.close(),10);});`;
};

async function run() {
  const key = execFileSync('openssl', ['genrsa', '2048'], { timeout: 5000 });
  const cert = execFileSync('openssl', ['req', '-new', '-x509', '-key', '/dev/stdin', '-subj', '/CN=localhost', '-days', '1'], { input: key, timeout: 5000 });
  const handler = (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    if (url.pathname === '/probe') {
      hits.push({ kind: 'http', arm: url.searchParams.get('arm'), mode: url.searchParams.get('mode') });
      response.setHeader('access-control-allow-origin', '*');
      response.end('worker-http-ok');
      return;
    }
    const arm = url.searchParams.get('arm');
    // Separate original policies exercise preservation of duplicate headers.
    response.setHeader('content-security-policy', arm.startsWith('strict-')
      ? ["connect-src 'none'", "img-src 'none'"] : "img-src 'none'");
    if (url.pathname === '/worker.js' || url.pathname === '/shared-worker.js') {
      response.setHeader('content-type', 'text/javascript');
      const config = JSON.parse(url.searchParams.get('config'));
      response.end(workerSource(config, url.pathname === '/shared-worker.js'));
    } else if (url.pathname === '/nested.js') {
      response.setHeader('content-type', 'text/javascript');
      const config = JSON.parse(url.searchParams.get('config'));
      const nestedBlob = url.searchParams.get('blob') === '1';
      const target = `/worker.js?arm=${encodeURIComponent(arm)}&config=${encodeURIComponent(JSON.stringify(config))}`;
      response.end(`const target=${nestedBlob
        ? `URL.createObjectURL(new Blob([${JSON.stringify(workerSource(config))}],{type:'text/javascript'}))`
        : JSON.stringify(target)};const child=new Worker(target);child.onmessage=e=>{self.postMessage(e.data);child.terminate();setTimeout(()=>self.close(),10)};child.onerror=e=>{self.postMessage({constructorOrWorkerError:e.message});child.terminate();self.close()};`);
    } else {
      response.setHeader('content-type', 'text/html');
      response.end('<title>Worker CSP feasibility</title>');
    }
  };
  plain = createServer(handler);
  tls = createHttpsServer({ key, cert }, handler);
  for (const server of [plain, tls]) {
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (request, socket) => {
      const url = new URL(request.url, 'http://fixture');
      hits.push({ kind: server === tls ? 'wss' : 'ws', arm: url.searchParams.get('arm'), mode: url.searchParams.get('mode') });
      const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      setTimeout(() => socket.destroy(), 250);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }
  browserServer = await chromium.launchServer({ headless: true, args: ['--ignore-certificate-errors'], timeout: 10000 });
  browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 10000 });
  console.log(JSON.stringify({ type: 'environment', browserVersion: browser.version(), addedPolicy, modes: MODES, cdpScope: 'page session only; worker-script response coverage recorded, not assumed' }));
  const origin = `http://127.0.0.1:${plain.address().port}`;
  for (const arm of ['control', 'added-policy', 'fulfilled-policy', 'strict-intersection', 'strict-fulfilled']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    cdp.on('Fetch.requestPaused', async event => {
      const stage = event.responseStatusCode !== undefined ? 'response' : 'request';
      const url = new URL(event.request.url);
      paused.push({ arm, stage, path: url.pathname });
      try {
        if (stage === 'response' && arm !== 'control' && ['/page', '/worker.js', '/shared-worker.js', '/nested.js'].includes(url.pathname)) {
          const headers = [...(event.responseHeaders ?? [])];
          headers.push({ name: 'Content-Security-Policy', value: addedPolicy });
          const useFulfillment = arm === 'fulfilled-policy' || arm === 'strict-fulfilled';
          const record = { arm, path: url.pathname, mechanism: useFulfillment ? 'fulfillRequest' : 'continueResponse', policies: headers.filter(h => h.name.toLowerCase() === 'content-security-policy').map(h => h.value) };
          injected.push(record);
          if (useFulfillment) {
            const body = await cdp.send('Fetch.getResponseBody', { requestId: event.requestId });
            const bytes = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
            if (bytes.byteLength > 256 * 1024) throw new Error('fixture-body-exceeds-256KiB');
            record.bodyBytes = bytes.byteLength;
            await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: event.responseStatusCode, responseHeaders: headers, body: bytes.toString('base64') });
          } else {
            await cdp.send('Fetch.continueResponse', { requestId: event.requestId, responseCode: event.responseStatusCode, responseHeaders: headers });
          }
        } else {
          await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
        }
      } catch (error) {
        handlerErrors.push({ arm, stage, path: url.pathname, error: String(error) });
        await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      }
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }, { urlPattern: '*', requestStage: 'Response' }] });
    await page.goto(`${origin}/page?arm=${arm}`, { timeout: 8000 });
    console.log(JSON.stringify({ type: 'navigation', arm, url: page.url(), expectedUrl: `${origin}/page?arm=${arm}` }));
    for (const mode of MODES) {
      const query = `arm=${arm}&mode=${mode}`;
      const config = { http: `${origin}/probe?${query}`, ws: `ws://127.0.0.1:${plain.address().port}/socket?${query}`, wss: `wss://127.0.0.1:${tls.address().port}/socket?${query}` };
      const external = `${origin}/${mode === 'external-shared' ? 'shared-worker.js' : mode.startsWith('nested-') ? 'nested.js' : 'worker.js'}?arm=${arm}&blob=${mode === 'nested-blob' ? '1' : '0'}&config=${encodeURIComponent(JSON.stringify(config))}`;
      const source = workerSource(config, mode === 'blob-shared');
      const result = await page.evaluate(({ mode, external, source }) => new Promise(resolve => {
        let worker;
        let blobUrl;
        let done = false;
        const shared = mode.endsWith('shared');
        const finish = value => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { shared ? worker?.port.close() : worker?.terminate(); } catch {}
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          resolve(value);
        };
        const timer = setTimeout(() => finish({ error: 'worker-result-timeout' }), 6000);
        try {
          let target = external;
          if (mode.startsWith('blob-')) target = blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
          if (mode.startsWith('data-')) target = 'data:text/javascript,' + encodeURIComponent(source);
          worker = shared ? new SharedWorker(target) : new Worker(target);
          worker.onerror = event => finish({ constructorOrWorkerError: event.message });
          const receiver = shared ? worker.port : worker;
          receiver.onmessage = event => finish(event.data);
          if (shared) worker.port.start();
        } catch (error) { finish({ constructorOrWorkerError: String(error) }); }
      }), { mode, external, source });
      const row = { type: 'result', arm, mode, result, hits: hits.filter(hit => hit.arm === arm && hit.mode === mode) };
      results.push(row);
      console.log(JSON.stringify(row));
    }
    await context.close();
  }
}

try {
  await Promise.race([run(), new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error('whole-probe-deadline-90000ms')), 90000);
  })]);
} catch (error) {
  console.log(JSON.stringify({ type: 'probe-error', error: String(error) }));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  console.log(JSON.stringify({ type: 'coverage', paused, injected, handlerErrors }));
  let cleanupTimeout;
  try {
    await Promise.race([browser?.close(), new Promise((_, reject) => {
      cleanupTimeout = setTimeout(() => reject(new Error('browser-close-timeout')), 5000);
    })]);
  } catch {
    await browserServer?.kill();
  } finally {
    clearTimeout(cleanupTimeout);
  }
  await browserServer?.close();
  for (const socket of sockets) socket.destroy();
  for (const server of [plain, tls]) {
    if (!server?.listening) continue;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({ type: 'cleanup', ownedBrowserStopped: !browserServer || browserServer.process().exitCode !== null || browserServer.process().signalCode !== null, remainingSockets: sockets.size }));
}
