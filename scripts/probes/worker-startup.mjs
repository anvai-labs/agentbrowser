// Diagnostic-only T1b falsification probe: native delivery, no Fetch/Network/CSP changes.
// node scripts/probes/worker-startup.mjs; exit 0 means fixture completed, NOT enforcement.
// One owned loopback server/browser. Depth 2 means parent worker + one child worker.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../../packages/engine-playwright/node_modules/playwright/index.mjs';
import { ChildCdp } from './child-cdp.mjs';
import { cleanupStartup } from './startup-cleanup.mjs';
import { executeWorker } from './worker-startup-fixture.mjs';
import { ARMS, MODES } from './verify-worker-startup.mjs';

if (process.argv.length !== 2) throw new Error('No arguments supported');
const HOLD_MS = 200;
const started = performance.now();
const now = () => performance.now() - started;
const urlKey = url => createHash('sha256').update(url).digest('hex');
const emit = row => console.log(JSON.stringify(row));
const scripts = new Map();
const sockets = new Set();
let active;
let browser;
let browserServer;
let origin;
let deadline;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  response.setHeader('cache-control', 'no-store');
  if (url.pathname === '/sentinel') {
    active?.record({ kind: 'hit', token: url.searchParams.get('token'), method: request.method });
    response.setHeader('access-control-allow-origin', '*');
    response.end('worker-startup-ok');
  } else if (scripts.has(url.pathname)) {
    response.setHeader('content-type', 'text/javascript');
    response.end(scripts.get(url.pathname));
  } else if (url.pathname === '/') {
    response.setHeader('content-type', 'text/html');
    response.end('<title>Worker startup feasibility</title>');
  } else { response.statusCode = 404; response.end(); }
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });

function source(config) { return `(${executeWorker.toString()})(${JSON.stringify(config)});`; }
function makeScript(arm, mode, depth = 1) {
  const token = `${arm}/${mode}/${depth}`;
  const config = { token, sentinel: `${origin}/sentinel?token=${encodeURIComponent(token)}`, shared: mode.endsWith('-shared') };
  if (depth === 1 && mode.startsWith('nested-')) config.child = makeScript(arm, mode, 2);
  const code = source(config);
  const external = mode.startsWith('external-') || mode === 'nested-external';
  if (external) {
    const path = `/worker/${arm}/${mode}/${depth}.js`;
    scripts.set(path, code);
    return { token, url: origin + path };
  }
  return { token, source: code };
}

const attachOptions = { autoAttach: true, waitForDebuggerOnStart: true, flatten: false, filter: [{ type: 'worker', exclude: false }, { exclude: true }] };
async function runCase(arm, mode) {
  const events = [];
  const errors = [];
  const bridges = [];
  const handlers = [];
  const tasks = new Set();
  const cancel = new AbortController();
  let closing = false;
  let contextClosed = false;
  const record = event => {
    if (events.length >= 99) { if (!errors.includes('event capacity')) errors.push('event capacity'); return; }
    events.push({ ...event, at: now() });
  };
  active = { record };
  const context = await browser.newContext();
  let result = { workers: [], results: [] };
  function observe(parent, parentSessionId = null, depth = 1) {
    const attached = event => {
      if (closing) return;
      if (bridges.length >= 8 || depth > 2) { errors.push('target capacity/depth exceeded'); return; }
      const { sessionId, targetInfo, waitingForDebugger } = event;
      record({ kind: 'attached', sessionId, parentSessionId, targetId: targetInfo.targetId, targetType: targetInfo.type, urlKey: urlKey(targetInfo.url), waitingForDebugger });
      const child = new ChildCdp(parent, sessionId);
      bridges.push(child);
      const task = (async () => {
        if (arm === 'recursive') {
          observe(child, sessionId, depth + 1);
          await child.send('Target.setAutoAttach', attachOptions);
          record({ kind: 'recursive-setup', sessionId });
        }
        await delay(HOLD_MS, undefined, { signal: cancel.signal });
        // Timestamp BEFORE send invocation (the bridge queues outer dispatch).
        // A hit before this lower bound definitively precedes our command.
        record({ kind: 'release-dispatch', sessionId });
        await child.send('Runtime.runIfWaitingForDebugger');
        record({ kind: 'release-ack', sessionId });
      })().catch(error => { if (!closing) errors.push(String(error)); });
      tasks.add(task);
      task.finally(() => tasks.delete(task));
    };
    const detached = event => record({ kind: 'detached', sessionId: event.sessionId });
    parent.on('Target.attachedToTarget', attached);
    parent.on('Target.detachedFromTarget', detached);
    handlers.push({ parent, attached, detached });
  }
  try {
    const page = await context.newPage();
    await page.goto(origin, { timeout: 5000 });
    if (arm !== 'native-control') {
      const cdp = await context.newCDPSession(page);
      observe(cdp);
      await cdp.send('Target.setAutoAttach', attachOptions);
      record({ kind: 'root-setup' });
    }
    const script = makeScript(arm, mode);
    record({ kind: 'launch' });
    result = await page.evaluate(({ script, mode }) => new Promise(resolve => {
      const url = script.url ?? (mode === 'data-dedicated'
        ? `data:text/javascript,${encodeURIComponent(script.source)}`
        : URL.createObjectURL(new Blob([script.source], { type: 'text/javascript' })));
      const timer = setTimeout(() => resolve({ workers: [], results: [{ error: 'worker result timeout' }] }), 5000);
      const worker = mode.endsWith('-shared') ? new SharedWorker(url, script.token) : new Worker(url);
      const receiver = mode.endsWith('-shared') ? worker.port : worker;
      receiver.onmessage = event => {
        clearTimeout(timer);
        resolve({ workers: [{ token: script.token, parentToken: null, url }, ...event.data.workers], results: event.data.results });
      };
      worker.onerror = event => { clearTimeout(timer); resolve({ workers: [], results: [{ error: event.message }] }); };
      if (mode.endsWith('-shared')) receiver.start();
    }), { script, mode });
    // New recursive tasks can appear while the parent task is pending.
    while (tasks.size) await Promise.all([...tasks]);
  } catch (error) { errors.push(String(error)); }
  finally {
    closing = true;
    cancel.abort();
    await context.close();
    contextClosed = true;
    for (const child of [...bridges].reverse()) child.close();
    await Promise.all([...tasks]);
    for (const { parent, attached, detached } of handlers) {
      parent.off('Target.attachedToTarget', attached);
      parent.off('Target.detachedFromTarget', detached);
    }
    active = null;
  }
  const listeners = handlers.reduce((sum, { parent, attached, detached }) => sum
    + Number(parent.listeners('Target.attachedToTarget').includes(attached))
    + Number(parent.listeners('Target.detachedFromTarget').includes(detached)), 0);
  emit({ kind: 'case', arm, mode, holdMs: HOLD_MS, ...result,
    workers: result.workers.map(({ url, ...worker }) => ({ ...worker, urlKey: urlKey(url) })), events, errors,
    cleanup: { pending: bridges.reduce((sum, child) => sum + child.pendingCount, 0), tasks: tasks.size, listeners, contextClosed } });
  scripts.clear();
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browserServer = await chromium.launchServer({ headless: true, timeout: 10000 });
  browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 10000 });
  // 90-second CASE execution deadline; launch/connect have separate 10s bounds.
  deadline = setTimeout(() => {
    console.error('startup probe case execution deadline');
    process.exitCode = 1;
    void browserServer.kill().catch(error => console.error('deadline kill failed:', String(error)));
  }, 90000);
  emit({ kind: 'environment', probe: 'worker-startup', chromium: browser.version(), node: process.version, platform: process.platform, arch: process.arch, holdMs: HOLD_MS, nativeDelivery: true, securityAcceptance: false });
  for (const arm of ARMS) for (const mode of MODES) await runCase(arm, mode);
} finally {
  clearTimeout(deadline);
  const cleanup = await cleanupStartup({ browser, browserServer, server, sockets });
  if (cleanup.errors.length) process.exitCode = 1;
  emit({ kind: 'cleanup', ...cleanup });
}
