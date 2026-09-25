/** Build first. Disposable headed profile; --live observes Yahoo, --disconnect checks resource loss. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../packages/api/dist/index.js';
import { PlaywrightChromiumEngine } from '../packages/engine-playwright/dist/index.js';
import { NetworkPolicy } from '../packages/policy/dist/index.js';
import { AgentBrowserClient } from '../packages/sdk-typescript/dist/index.js';
import { checkMcp, runExecutable } from './release-smoke.mjs';
const require = createRequire(
  new URL('../packages/engine-playwright/package.json', import.meta.url)
);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
const live = process.argv.includes('--live');
const disconnect = process.argv.includes('--disconnect');
assert.ok(process.argv.slice(2).every((arg) => arg === '--live' || arg === '--disconnect'));
const profile = await mkdtemp(join(tmpdir(), 'agentbrowser-cdp-smoke-'));
const chrome = spawn(
  process.env.AGENTBROWSER_CHROME_PATH ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    'about:blank',
  ],
  { stdio: 'ignore' }
);
let spawnError;
chrome.on('error', (error) => {
  spawnError = error;
});
let observer;
let server;
let disabled;
const fixture = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(
    `<title>CDP profile fixture</title><button>${request.headers.cookie?.includes('operator-marker=shared') ? 'Shared profile confirmed' : 'No profile marker'}</button>`
  );
});
try {
  let port;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (spawnError) throw new Error('Unable to launch dedicated smoke Chrome');
    const active = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    if (/^[0-9]+\n/.test(active)) {
      port = Number(active.split('\n')[0]);
      break;
    }
    await delay(100);
  }
  assert.ok(port, 'Dedicated Chrome debugging endpoint not ready');
  const endpoint = `http://127.0.0.1:${port}`;
  observer = await chromium.connectOverCDP(endpoint, { noDefaults: true });
  const context = observer.contexts()[0];
  assert.ok(context);
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${fixture.address().port}/`;
  await context.addCookies([{ name: 'operator-marker', value: 'shared', url: target }]);
  const sentinel = await context.newPage();
  await sentinel.goto(target);
  const existing = new Set(context.pages());
  const key = randomUUID();
  const apiKeys = new Map([[createHash('sha256').update(key).digest('hex'), 'cdp-smoke']]);
  const operatorCdp = { endpoint, allowUnenforcedEgress: true };
  server = await buildServer({
    engine: new PlaywrightChromiumEngine({ operatorCdp }),
    operatorCdp,
    apiKeys,
    networkPolicy: new NetworkPolicy({
      blockLoopback: false,
      blockPrivateIPs: true,
      blockMetadata: true,
    }),
  });
  const baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
  const { AGENTBROWSER_SESSION_ID: _inheritedSession, ...baseEnvironment } = process.env;
  const env = {
    ...baseEnvironment,
    AGENTBROWSER_BASE_URL: baseUrl,
    AGENTBROWSER_API_KEY: key,
    AGENTBROWSER_MODE: 'qa',
  };
  const client = new AgentBrowserClient({ baseUrl, apiKey: key, timeout: 60000 });
  const cli = async (...args) => {
    const result = await runExecutable(
      [
        process.execPath,
        join(root, 'packages/cli/dist/bin.js'),
        '--base-url',
        baseUrl,
        '--timeout',
        '60000',
        '--json',
        ...args,
      ],
      { env, timeoutMs: 65000 }
    );
    return JSON.parse(result.stdout);
  };
  const session = await cli('session', 'create', '--tenant', 'cdp-smoke', '--cdp-attach');
  assert.equal(session.diagnostics.attachment, 'cdp_attach');
  assert.equal(session.diagnostics.egress, 'navigation_preflight_only');
  assert.ok(session.warnings.length >= 2);
  for (const view of [
    await client.sessions.get(session.sessionId),
    ...(await client.sessions.list()),
  ]) {
    assert.deepEqual(view.diagnostics, session.diagnostics);
    assert.deepEqual(view.warnings, session.warnings);
  }
  assert.equal((await client.sessions.listPages(session.sessionId)).length, 0);
  const page = await client.sessions.createPage(session.sessionId);
  assert.equal((await cli('navigate', session.sessionId, page.pageId, target)).status, 'success');
  const observation = await client.sessions.observe(session.sessionId, page.pageId, {
    mode: 'interactive',
  });
  assert.match(JSON.stringify(observation), /Shared profile confirmed/);
  await assert.rejects(
    client.sessions.cookies(session.sessionId),
    (error) => error.details?.reason === 'PROFILE_COOKIE_EXPORT_UNSUPPORTED'
  );
  await assert.rejects(
    client.sessions.navigate(session.sessionId, page.pageId, { url: 'http://192.168.1.90/' }),
    (error) => error.details?.reason === 'egress_policy'
  );
  // Independent observer operates only the local fixture and models an operator popup.
  await sentinel.evaluate((url) => window.open(url), target);
  await delay(200);
  assert.equal((await client.sessions.listPages(session.sessionId)).length, 1);
  const owned = context
    .pages()
    .find(
      (candidate) =>
        !existing.has(candidate) && candidate.url() === target && candidate !== sentinel
    );
  assert.ok(owned);
  await owned.evaluate((url) => window.open(url), target);
  for (
    let attempt = 0;
    attempt < 30 && (await client.sessions.listPages(session.sessionId)).length < 2;
    attempt++
  )
    await delay(100);
  assert.equal((await client.sessions.listPages(session.sessionId)).length, 2);
  if (live) {
    const result = await cli(
      'navigate',
      session.sessionId,
      page.pageId,
      'https://finance.yahoo.com/quote/AAPL',
      '--wait-until',
      'domcontentloaded'
    );
    const observed = await client.sessions.observe(session.sessionId, page.pageId, {
      mode: 'interactive',
      maxBytes: 16000,
    });
    console.log(
      JSON.stringify({ live: 'Yahoo AAPL', status: result.status, title: observed.title ?? null })
    );
    assert.equal(result.status, 'success');
  }
  await client.sessions.close(session.sessionId);
  assert.equal(sentinel.isClosed(), false);
  assert.equal((await fetch(`${endpoint}/json/version`)).status, 200);
  await checkMcp([process.execPath, join(root, 'packages/mcp-server/dist/bin.js')], {
    expectedVersion: version,
    env,
    timeoutMs: 120000,
    async exercise({ request }) {
      const created = await request('tools/call', {
        name: 'browser_create',
        arguments: { tenantId: 'cdp-smoke', cdpAttach: true },
      });
      assert.notEqual(created.isError, true);
      const value = created.structuredContent ?? JSON.parse(created.content[0].text);
      assert.equal(value.diagnostics.attachment, 'cdp_attach');
      assert.ok(value.pageId);
      await client.sessions.close(value.sessionId);
    },
  });
  disabled = await buildServer({ engine: new PlaywrightChromiumEngine(), apiKeys });
  const disabledUrl = await disabled.listen({ host: '127.0.0.1', port: 0 });
  const refusal = await fetch(`${disabledUrl}/v1/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId: 'cdp-smoke', cdpAttach: true }),
  });
  const refused = await refusal.json();
  assert.equal(refusal.status, 422);
  assert.equal(refused.error.details.reason, 'CDP_ATTACH_DISABLED');
  assert.match(refused.error.message, /AGENTBROWSER_CDP_ENDPOINT/);
  assert.equal(sentinel.isClosed(), false);
  const browserVersion = observer.version();
  if (disconnect) {
    const attached = await client.sessions.create({ tenantId: 'cdp-smoke', cdpAttach: true });
    const first = await client.sessions.createPage(attached.sessionId);
    await client.sessions.closePage(attached.sessionId, first.pageId);
    assert.equal((await client.sessions.listPages(attached.sessionId)).length, 0);
    assert.equal((await client.sessions.get(attached.sessionId)).sessionId, attached.sessionId);
    await client.sessions.createPage(attached.sessionId);
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill('SIGTERM');
    await Promise.race([exited, delay(5000)]);
    assert.ok(
      chrome.exitCode !== null || chrome.signalCode !== null,
      'Fixture Chrome did not stop'
    );
    let ended;
    for (let attempt = 0; attempt < 50; attempt++) {
      ended = await fetch(`${baseUrl}/v1/sessions/${attached.sessionId}`, {
        headers: { authorization: `Bearer ${key}` },
      });
      if (ended.status === 404) break;
      await delay(100);
    }
    assert.equal(ended.status, 404, 'Disconnected browser must end the logical session');
    const envelope = await ended.json();
    assert.equal(envelope.error.details.sessionTerminal.closeCause, 'engine_disconnected');
    assert.equal(envelope.error.details.sessionTerminal.state, 'engine_disconnected');
    assert.equal(envelope.error.details.sessionTerminal.leaseRemainingMs, 0);
    assert.ok(
      envelope.error.details.sessionTerminal.lease.expiresAt >
        envelope.error.details.sessionTerminal.endedAt
    );
    await assert.rejects(
      client.sessions.get(attached.sessionId),
      (error) => error.details?.sessionTerminal?.closeCause === 'engine_disconnected'
    );
    assert.equal((await fetch(`${baseUrl}/v1/sessions/${attached.sessionId}`)).status, 401);
    const command = await runExecutable(
      [
        process.execPath,
        join(root, 'packages/cli/dist/bin.js'),
        '--base-url',
        baseUrl,
        'session',
        'get',
        attached.sessionId,
      ],
      { env, expectedExitCode: 1 }
    );
    assert.match(command.stderr, /close-cause=engine_disconnected/);
    await checkMcp([process.execPath, join(root, 'packages/mcp-server/dist/bin.js')], {
      expectedVersion: version,
      env,
      timeoutMs: 120000,
      async exercise({ request }) {
        const value = await request('tools/call', {
          name: 'browser_session',
          arguments: { sessionId: attached.sessionId },
        });
        assert.equal(value.isError, true);
        assert.match(value.content[0].text, /close-cause=engine_disconnected/);
      },
    });
    assert.doesNotMatch(
      JSON.stringify(envelope),
      /operator_window_closed|"closeCause":"engine_crash"|DevToolsActivePort/
    );
    console.log(
      JSON.stringify({
        disconnectQualification: 'PASS',
        closeCause: 'engine_disconnected',
        lastPageClosePreservesSession: true,
        transports: ['REST', 'SDK', 'CLI', 'MCP'],
      })
    );
  }
  console.log(
    JSON.stringify({
      qualification: 'PASS',
      productVersion: version,
      browserVersion,
      endpointClass: 'loopback_http',
      profileSharing: true,
      unownedTabsPreserved: true,
      ownedPopupAdopted: true,
      detachPreservedBrowser: true,
      disabledRefusal: refused.error.details.reason,
    })
  );
} finally {
  await disabled?.close();
  await server?.close();
  await observer?.close();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  if (chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => chrome.once('exit', resolve)), delay(5000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
  }
  await rm(profile, { recursive: true, force: true });
}
