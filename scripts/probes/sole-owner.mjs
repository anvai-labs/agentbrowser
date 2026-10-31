// T1 causal diagnostic only. Run: node scripts/probes/sole-owner.mjs /absolute/path/to/pinned/chrome-headless-shell
// No Playwright import/client, Fetch/CSP/body replay, certificate bypass or security grants.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { connectCdp } from './raw-cdp.mjs';
import { initializeWorker, workerAttachOptions } from './owner-release.mjs';
import { executeWorker } from './worker-startup-fixture.mjs';

const executable = process.argv[2];
if (process.argv.length !== 3 || !isAbsolute(executable)) throw new Error('Supply absolute pinned Chromium executable path');
const require = createRequire(realpathSync(new URL('../../packages/engine-playwright/node_modules/playwright/package.json', import.meta.url)));
const manifest = JSON.parse(readFileSync(join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8'));
const pinned = manifest.browsers.find(browser => browser.name === 'chromium-headless-shell');
const executableVersion = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
if (!executableVersion.includes(pinned.browserVersion)) throw new Error('Executable does not match pinned Chromium version');
const ARMS = ['immediate', 'delayed', 'competitor'];
const MODES = ['external-dedicated', 'nested-external'];
const scripts = new Map();
const sockets = new Set();
const started = performance.now();
const now = () => performance.now() - started;
const emit = row => console.log(JSON.stringify(row));
let active;
let profile;
let childProcess;
let endpoint;
let origin;
let watchdog;
let processExited = false;
const errors = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  response.setHeader('cache-control', 'no-store');
  if (url.pathname === '/sentinel') {
    active?.({ kind: 'hit', token: url.searchParams.get('token'), method: request.method });
    response.setHeader('access-control-allow-origin', '*');
    response.end('worker-startup-ok');
  } else if (scripts.has(url.pathname)) {
    active?.({ kind: 'script-request', token: url.pathname.slice('/worker/'.length, -3) });
    response.setHeader('content-type', 'text/javascript');
    response.end(scripts.get(url.pathname));
  } else if (url.pathname === '/') {
    response.setHeader('content-type', 'text/html');
    response.end('<title>Worker startup feasibility</title>');
  } else { response.statusCode = 404; response.end(); }
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
function makeScript(prefix, nested, depth = 1) {
  const token = `${prefix}/${depth}`;
  const config = { token, sentinel: `${origin}/sentinel?token=${encodeURIComponent(token)}`, shared: false };
  if (depth === 1 && nested) config.child = makeScript(prefix, nested, 2);
  const path = `/worker/${token}.js`;
  scripts.set(path, `(${executeWorker.toString()})(${JSON.stringify(config)});`);
  return { token, url: origin + path };
}

async function runCase(arm, mode, repeat) {
  const events = [];
  const caseErrors = [];
  const owners = [];
  const tasks = new Set();
  const abort = new AbortController();
  let closing = false;
  let contextId;
  let targetId;
  let contextClosed = false;
  let cancelLoad = () => {};
  let result = { workers: [], results: [] };
  const record = event => {
    if (events.length >= 199) { if (!caseErrors.includes('event capacity')) caseErrors.push('event capacity'); return; }
    events.push({ ...event, at: now() });
  };
  active = record;
  const prefix = `${arm}/${repeat}/${mode}`;
  try {
    for (const name of arm === 'competitor' ? ['primary', 'competitor'] : ['primary']) {
      const cdp = await connectCdp(endpoint, { record: event => record({ ...event, owner: name }) });
      const owner = { name, cdp, pageSessionId: null, sessions: new Map() };
      owners.push(owner);
      cdp.on('closed', error => { if (!closing) { caseErrors.push(String(error)); abort.abort(); } });
      cdp.on('event', message => {
        if (message.method === 'Target.detachedFromTarget') {
          record({ kind: 'detached', owner: name, sessionId: message.params.sessionId });
          return;
        }
        if (message.method !== 'Target.attachedToTarget' || message.params.targetInfo.type !== 'worker' || closing) return;
        const { sessionId, targetInfo, waitingForDebugger } = message.params;
        const parentSessionId = message.sessionId;
        const parent = owner.sessions.get(parentSessionId);
        const depth = parentSessionId === owner.pageSessionId ? 1 : parent ? parent.depth + 1 : 0;
        record({ kind: 'attached', owner: name, sessionId, parentSessionId, targetId: targetInfo.targetId, url: targetInfo.url, depth, waitingForDebugger });
        if (owner.sessions.size >= 2 || !depth || depth > 2) { caseErrors.push('target lineage/capacity'); abort.abort(); return; }
        owner.sessions.set(sessionId, { targetId: targetInfo.targetId, depth });
        const task = initializeWorker({
          send: (method, params) => cdp.send(method, params, sessionId),
          holdMs: arm === 'immediate' || name === 'competitor' ? 0 : 200,
          signal: abort.signal,
          abort: async () => {
            record({ kind: 'target-abort', owner: name, targetId: targetInfo.targetId });
            // Closing the owned page aborts its workers; do not release on setup failure.
            await owners[0].cdp.send('Target.closeTarget', { targetId });
          },
        }).catch(error => { if (!closing) { caseErrors.push(String(error)); abort.abort(); } });
        tasks.add(task);
        task.finally(() => tasks.delete(task));
      });
    }
    const primary = owners[0].cdp;
    const version = await primary.send('Browser.getVersion');
    if (version.product.split('/').at(-1) !== pinned.browserVersion) throw new Error('Runtime Chromium version mismatch');
    contextId = (await primary.send('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId;
    targetId = (await primary.send('Target.createTarget', { url: 'about:blank', browserContextId: contextId })).targetId;
    for (const owner of owners) {
      owner.pageSessionId = (await owner.cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
      record({ kind: 'page-session', owner: owner.name, sessionId: owner.pageSessionId, targetId });
      await owner.cdp.send('Target.setAutoAttach', workerAttachOptions, owner.pageSessionId);
    }
    const pageSession = owners[0].pageSessionId;
    await primary.send('Page.enable', {}, pageSession);
    const loaded = new Promise((resolve, reject) => {
      const listener = message => { if (message.method === 'Page.loadEventFired' && message.sessionId === pageSession) finish(); };
      const finish = error => { clearTimeout(timer); primary.off('event', listener); if (error) reject(error); else resolve(); };
      const timer = setTimeout(() => finish(new Error('page load timeout')), 5000);
      cancelLoad = finish;
      primary.on('event', listener);
    });
    // Attach a rejection handler immediately if navigation itself fails first.
    loaded.catch(() => {});
    await primary.send('Page.navigate', { url: origin }, pageSession);
    await loaded;
    const script = makeScript(prefix, mode === 'nested-external');
    record({ kind: 'launch' });
    const expression = `new Promise(resolve=>{const script=${JSON.stringify(script)};const worker=new Worker(script.url);const timer=setTimeout(()=>resolve({workers:[],results:[{error:'worker result timeout'}]}),5000);worker.onmessage=e=>{clearTimeout(timer);resolve({workers:[{token:script.token,parentToken:null,url:script.url},...e.data.workers],results:e.data.results})};worker.onerror=e=>{clearTimeout(timer);resolve({workers:[],results:[{error:e.message}]})}})`;
    const evaluated = await primary.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, pageSession, 8000);
    if (evaluated.exceptionDetails || !evaluated.result?.value) throw new Error('worker evaluation failed');
    result = evaluated.result.value;
    while (tasks.size) await Promise.all([...tasks]);
  } catch (error) { caseErrors.push(String(error)); }
  finally {
    closing = true;
    abort.abort();
    cancelLoad(new Error('owned context closing'));
    if (contextId) {
      try { await owners[0].cdp.send('Target.disposeBrowserContext', { browserContextId: contextId }); contextClosed = true; }
      catch (error) { caseErrors.push(String(error)); }
    }
    for (const owner of owners) owner.cdp.close();
    await Promise.all([...tasks]);
    active = null;
  }
  emit({ kind: 'case', arm, mode, repeat, ...result, events, errors: caseErrors,
    cleanup: { pending: owners.reduce((sum, owner) => sum + owner.cdp.pendingCount, 0), tasks: tasks.size, contextClosed, connections: owners.length,
      closedConnections: owners.filter(owner => owner.cdp.closed).length, listeners: owners.reduce((sum, owner) => sum + owner.cdp.listenerCount('event') + owner.cdp.listenerCount('closed'), 0) } });
  scripts.clear();
  if (caseErrors.length) throw new Error(`Invalid case ${prefix}`);
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(join(tmpdir(), 'agentbrowser-sole-owner-'));
  const args = ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
  childProcess = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  childProcess.on('error', error => { errors.push(`owned process: ${String(error)}`); });
  childProcess.once('exit', () => { processExited = true; });
  endpoint = await new Promise((resolve, reject) => {
    let buffer = '';
    const finish = (error, value) => {
      clearTimeout(timer);
      childProcess.stderr.off('data', data);
      childProcess.off('error', failed);
      childProcess.off('exit', exited);
      // Drain remaining stderr without retaining browser output.
      childProcess.stderr.resume();
      if (error) reject(error); else resolve(value);
    };
    const failed = error => finish(error);
    const exited = () => finish(new Error('Chromium exited before endpoint discovery'));
    const data = chunk => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 32768) return finish(new Error('endpoint output capacity'));
      const found = buffer.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/);
      if (found) finish(null, found[1]);
    };
    const timer = setTimeout(() => finish(new Error('Chromium startup timeout')), 10000);
    childProcess.on('error', failed);
    childProcess.on('exit', exited);
    childProcess.stderr.on('data', data);
  });
  watchdog = setTimeout(() => { errors.push('case execution deadline'); childProcess.kill('SIGKILL'); }, 90000);
  emit({ kind: 'environment', probe: 'sole-owner', executableVersion, revision: pinned.revision, node: process.version, platform: process.platform, arch: process.arch,
    launchArgs: args.map(arg => arg.startsWith('--user-data-dir=') ? '--user-data-dir=<owned-temporary-profile>' : arg), playwrightConnected: false, nativeDelivery: true, securityAcceptance: false, repeats: 3, instrumentation: 2 });
  for (const arm of ARMS) for (let repeat = 1; repeat <= 3; repeat++) for (const mode of MODES) await runCase(arm, mode, repeat);
} catch (error) { errors.push(String(error)); process.exitCode = 1; }
finally {
  clearTimeout(watchdog);
  if (endpoint && !processExited) {
    let cdp;
    try { cdp = await connectCdp(endpoint); await cdp.send('Browser.close'); }
    catch (error) { errors.push(`browser close: ${String(error)}`); }
    finally { cdp?.close(); }
  }
  const waitExit = async () => { for (let i = 0; i < 30 && childProcess && !processExited; i++) await delay(100); };
  await waitExit();
  if (childProcess && !processExited) { errors.push('forced browser termination'); childProcess.kill('SIGKILL'); await waitExit(); }
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  await delay(0);
  let profileRemoved = false;
  if (profile && (!childProcess || processExited)) {
    try { await rm(profile, { recursive: true, force: true, maxRetries: 2 }); profileRemoved = true; }
    catch (error) { errors.push(`profile cleanup: ${String(error)}`); }
  }
  if (errors.length) process.exitCode = 1;
  emit({ kind: 'cleanup', processExited, sockets: sockets.size, serverClosed: !server.listening, profileRemoved, errors });
}
