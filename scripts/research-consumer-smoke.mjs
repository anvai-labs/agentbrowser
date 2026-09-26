/** Real-browser research qualification. Build first; --headed opens an owned window. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConsumerSmokeRuntime } from './consumer-smoke-runtime.mjs';
import { checkMcp, runExecutable } from './release-smoke.mjs';

const runtime = await loadConsumerSmokeRuntime({
    headed: { type: 'boolean', default: false },
});
const {
  values: { headed },
  version,
  buildServer,
  PlaywrightChromiumEngine,
  NetworkPolicy,
  cliCommand,
  mcpCommand,
  provenance,
} = runtime;
const { AgentBrowserClient, sessionTerminalFailureDetail } = runtime.sdk;
const MiB = 1024 * 1024;
const sizes = [13, 52];
const text = 'Revenue and MD&A: café 😀 "quarterly" operating cash flow. '.repeat(22_000);
const json = JSON.stringify({ cik: '0000000001', filings: 'quarterly '.repeat(21_000), tail: 'END-JSON' });
const fixture = createServer((request, response) => {
  if (request.url === '/cookie') {
    response.setHeader('set-cookie', 'research=shared; Path=/; SameSite=Lax');
    response.end('<html><body>cookie seeded</body></html>');
    return;
  }
  if (request.url === '/echo') {
    response.end(`<html><body>cookie:${request.headers.cookie ?? 'none'}</body></html>`);
    return;
  }
  if (request.url === '/maintenance') { response.writeHead(503); response.end('<html><body>Maintenance</body></html>'); return; }
  if (request.url === '/redirect') { response.writeHead(302, { location: '/echo' }); response.end(); return; }
  if (request.url === '/disconnect') { response.destroy(); return; }
  if (request.url === '/submissions.json') {
    response.setHeader('content-type', 'application/json');
    response.end(json);
    return;
  }
  const size = Number(request.url?.slice(1));
  if (!sizes.includes(size)) { response.writeHead(404); response.end('not found'); return; }
  const before = '<!doctype html><html><head><title>Filing</title></head><body><!--';
  const after = `--><h1>Quarterly filing</h1><p>${text}</p><p>END-FILING-${size}</p></body></html>`;
  const padding = 'x'.repeat(size * MiB - Buffer.byteLength(before + after));
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(before + padding + after);
});
const key = randomUUID();
const engine = new PlaywrightChromiumEngine();
const server = await buildServer({
  engine,
  extractMaxBytes: 2 * MiB,
  // Deliberately permit loopback and large responses for this isolated fixture workload.
  networkPolicy: new NetworkPolicy({ maxResponseSize: 64 * MiB }),
  apiKeys: new Map([[createHash('sha256').update(key).digest('hex'), 'research-smoke']]),
});
const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-research-smoke-'));
const measurements = [];
let workflowError;
let workflowFailed = false;
try {
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  const baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
  const client = new AgentBrowserClient({ baseUrl, apiKey: key });
  const env = { ...process.env, AGENTBROWSER_BASE_URL: baseUrl, AGENTBROWSER_API_KEY: key, AGENTBROWSER_MODE: 'qa' };
  delete env.AGENTBROWSER_SESSION_ID;
  await checkMcp(mcpCommand, {
    expectedVersion: version, env, timeoutMs: 180_000, maxOutputBytes: 32 * MiB,
    async exercise({ callTool, request }) {
      const session = await callTool('browser_create', { tenantId: 'research-smoke', headless: !headed });
      assert.equal(typeof session.pageId, 'string');
      const scope = { sessionId: session.sessionId, pageId: session.pageId };
      let explicitlyClosed = false;
      try {
        const sdkView = await client.sessions.get(scope.sessionId);
        const restView = await (await fetch(`${baseUrl}/v1/sessions/${scope.sessionId}`, {
          headers: { authorization: `Bearer ${key}` },
        })).json();
        const cliResult = await runExecutable([...cliCommand, '--base-url', baseUrl, '--json', 'session', 'get', scope.sessionId], { env });
        const cliView = JSON.parse(cliResult.stdout);
        const inspected = await callTool('browser_session', { sessionId: scope.sessionId });
        const listedSession = (await client.sessions.list()).find((item) => item.sessionId === scope.sessionId);
        assert.ok(session.diagnostics, 'The creating engine captures launch diagnostics');
        assert.ok(sdkView.lease, 'Service lease must be visible');
        for (const view of [sdkView, restView, cliView, inspected.session, listedSession]) {
          assert.deepEqual(view.engine, session.engine, 'All surfaces preserve selected adapter identity');
          assert.ok(Number.isSafeInteger(view.lease?.sampledAt));
          for (const field of ['expiresAt', 'lastActivityAt', 'idleExpiresAt']) {
            assert.equal(view.lease[field], sdkView.lease[field], 'Inspection must not renew or invent lease facts');
          }
          assert.equal(view.lease.expiresAt, Date.parse(view.createdAt) + view.ttlMs);
          assert.equal(view.lease.idleExpiresAt, view.lease.lastActivityAt + view.idleTimeoutMs);
          assert.equal(view.leaseRemainingMs, Math.max(0, Math.min(view.lease.expiresAt, view.lease.idleExpiresAt) - view.lease.sampledAt));
          assert.deepEqual(view.diagnostics, session.diagnostics, 'All surfaces project the same captured facts');
        }
        assert.equal(session.diagnostics.attachment, 'local_launch');
        assert.equal(session.diagnostics.launchMode, headed ? 'headed' : 'headless');
        assert.equal(session.diagnostics.resourceModel, headed ? 'dedicated_local_browser' : 'shared_local_browser');
        assert.equal(session.diagnostics.context.initScript, headed ? 'registered' : 'not_registered');
        assert.equal(session.diagnostics.context.viewport.mode, headed ? 'no_viewport' : 'fixed');
        assert.equal(typeof session.diagnostics.browserVersion, 'string');
        assert.ok(['explicit', 'detected', 'playwright_default'].includes(session.diagnostics.executableSelection));
        for (const size of sizes) {
          const started = performance.now();
          const url = `${fixtureUrl}/${size}`;
          const navigated = await request('tools/call', { name: 'browser_navigate', arguments: { ...scope, url } });
          assert.notEqual(navigated.isError, true, `Fixture navigation failed: ${JSON.stringify(navigated.content)}`);
          assert.equal(JSON.parse(navigated.content[0].text).url, url);
          const result = await callTool('browser_extract', { ...scope, format: 'text' });
          assert.equal(result.data.text, `Quarterly filing ${text.trim()} END-FILING-${size}`);
          assert.equal(result.evidence[0].url, url);
          assert.ok(result.evidence[0].revision > 0);
          assert.match(result.evidence[0].hash, /^[a-f0-9]{8}$/);
          const bytes = Buffer.byteLength(JSON.stringify(result));
          assert.ok(bytes > MiB && bytes < 2 * MiB, 'Fixture must cross the default extraction ceiling');
          const limited = await request('tools/call', { name: 'browser_extract', arguments: { ...scope, format: 'text', maxBytes: MiB } });
          assert.equal(limited.isError, true);
          assert.match(limited.content[0].text, /OUTPUT_TRUNCATED/);
          assert.ok(!limited.content[0].text.includes('END-FILING'));
          const repeated = await client.sessions.extract(scope.sessionId, scope.pageId, { format: 'text', maxBytes: bytes });
          assert.deepEqual(repeated, result, 'SDK and MCP preserve complete data and evidence');
          const file = join(directory, `filing-${size}.json`);
          await writeFile(file, JSON.stringify(result), { mode: 0o600 });
          const grep = await runExecutable(['rg', '-o', `END-FILING-${size}`, file]);
          assert.equal(grep.stdout.trim(), `END-FILING-${size}`);
          measurements.push({ htmlBytes: size * MiB, resultBytes: bytes, evidenceHash: result.evidence[0].hash, elapsedMs: Math.round(performance.now() - started) });
        }
        await callTool('browser_navigate', { ...scope, url: `${fixtureUrl}/submissions.json` });
        const result = await callTool('browser_extract', { ...scope, format: 'text' });
        assert.ok(result.data.text.includes('END-JSON'));
        assert.ok(result.data.text.includes('0000000001'));
        const unknown = await request('tools/call', { name: 'browser_navigate', arguments: { ...scope, pageId: 'invented-page', url: fixtureUrl } });
        assert.equal(unknown.isError, true);
        assert.equal((await client.sessions.listPages(scope.sessionId)).length, 1);
        await callTool('browser_navigate', { ...scope, url: `${fixtureUrl}/cookie` });
        const page = await callTool('browser_page_create', { sessionId: scope.sessionId, url: `${fixtureUrl}/echo` });
        assert.notEqual(page.pageId, scope.pageId);
        const second = { sessionId: scope.sessionId, pageId: page.pageId };
        const cookie = await callTool('browser_extract', { ...second, format: 'text' });
        assert.equal(cookie.data.text, 'cookie:research=shared');
        const listed = await callTool('browser_pages', { sessionId: scope.sessionId });
        assert.deepEqual(listed.pages.map((p) => p.pageId).sort(), [scope.pageId, page.pageId].sort());
        for (const url of ['file:///private', `${fixtureUrl}/disconnect`]) {
          const failed = await request('tools/call', { name: 'browser_page_create', arguments: { sessionId: scope.sessionId, url } });
          assert.equal(failed.isError, true);
          assert.equal((await client.sessions.listPages(scope.sessionId)).length, 2, 'Failed create must not leave a registered page');
        }
        const isolated = await callTool('browser_create', { tenantId: 'research-smoke', headless: !headed });
        try {
          const isolatedScope = { sessionId: isolated.sessionId, pageId: isolated.pageId };
          await callTool('browser_navigate', { ...isolatedScope, url: `${fixtureUrl}/echo` });
          assert.equal((await callTool('browser_extract', { ...isolatedScope, format: 'text' })).data.text, 'cookie:none');
        } finally { await client.sessions.close(isolated.sessionId); }
        assert.equal((await callTool('browser_navigate', { ...second, url: `${fixtureUrl}/redirect` })).url, `${fixtureUrl}/echo`);
        assert.equal((await callTool('browser_navigate', { ...second, url: `${fixtureUrl}/maintenance` })).status, 'success');
        assert.equal((await callTool('browser_extract', { ...second, format: 'text' })).data.text, 'Maintenance');
        await client.sessions.closePage(scope.sessionId, page.pageId);
        assert.equal((await callTool('browser_pages', { sessionId: scope.sessionId })).pages.length, 1);
        await client.sessions.close(scope.sessionId);
        explicitlyClosed = true;
        const endedRest = await fetch(`${baseUrl}/v1/sessions/${scope.sessionId}`, { headers: { authorization: `Bearer ${key}` } });
        assert.equal(endedRest.status, 404);
        const terminal = (await endedRest.json()).error.details.sessionTerminal;
        assert.equal(terminal.closeCause, 'explicit_close');
        assert.equal(terminal.leaseRemainingMs, 0);
        assert.ok(terminal.lease.expiresAt > terminal.endedAt);
        await assert.rejects(client.sessions.get(scope.sessionId), (error) => {
          assert.deepEqual(sessionTerminalFailureDetail(error), terminal);
          return true;
        });
        const cliEnded = await runExecutable([...cliCommand, '--base-url', baseUrl, 'session', 'get', scope.sessionId], { env, expectedExitCode: 1 });
        assert.match(cliEnded.stderr, /close-cause=explicit_close/);
        const mcpEnded = await request('tools/call', { name: 'browser_session', arguments: { sessionId: scope.sessionId } });
        assert.equal(mcpEnded.isError, true);
        assert.match(mcpEnded.content[0].text, /close-cause=explicit_close/);
      } finally { if (!explicitlyClosed) await client.sessions.close(scope.sessionId); }
    },
  });
  const controlled = await client.sessions.create({ tenantId: 'research-smoke', controlMode: 'delegated', headless: !headed });
  try {
    const review = await client.sessions.prepareResume(controlled.sessionId);
    const grant = await client.sessions.delegate(controlled.sessionId, review.epoch, 'qa');
    await checkMcp(mcpCommand, {
      expectedVersion: version, env: { ...env, AGENTBROWSER_API_KEY: grant.token, AGENTBROWSER_SESSION_ID: controlled.sessionId }, catalog: 'delegated', timeoutMs: 30_000,
      async exercise({ callTool, request }) {
        const inspection = await callTool('browser_session', {});
        assert.deepEqual(inspection.session.diagnostics, controlled.diagnostics);
        assert.deepEqual(inspection.session.engine, controlled.engine);
        assert.ok(inspection.control);
        assert.equal(inspection.session.lease.expiresAt, controlled.lease.expiresAt);
        assert.ok(Number.isSafeInteger(inspection.session.lease.sampledAt));
        const args = { url: `${fixtureUrl}/echo`, operationId: 'controlled-page-1' };
        const page = await callTool('browser_page_create', args);
        // Model a lost first result: use only known operation ID + inventory afterwards.
        const replay = await request('tools/call', { name: 'browser_page_create', arguments: args });
        assert.equal(replay.isError, true);
        assert.match(replay.content[0].text, /OPERATION_RECORDED/);
        const conflict = await request('tools/call', { name: 'browser_page_create', arguments: { ...args, url: `${fixtureUrl}/maintenance` } });
        assert.equal(conflict.isError, true);
        assert.match(conflict.content[0].text, /OPERATION_CONFLICT/);
        const status = await callTool('browser_operation', { operationId: args.operationId });
        assert.equal(status.status, 'completed');
        assert.equal(status.pageId, undefined, 'No result correlation is promised');
        assert.deepEqual((await callTool('browser_pages', {})).pages.map((p) => p.pageId), [page.pageId]);
        const wrong = await request('tools/call', { name: 'browser_page_create', arguments: { ...args, sessionId: 'other' } });
        assert.equal(wrong.isError, true);
        await client.sessions.takeover(controlled.sessionId);
        for (const [name, arguments_] of [['browser_page_create', { operationId: 'revoked-create' }], ['browser_pages', {}], ['browser_session', {}]]) {
          const revoked = await request('tools/call', { name, arguments: arguments_ });
          assert.equal(revoked.isError, true, 'An old grant cannot list or create after takeover');
          assert.ok(!JSON.stringify(revoked).includes('idleExpiresAt'));

        }
        const refused = await fetch(`${baseUrl}/v1/sessions/${controlled.sessionId}`, { headers: { authorization: `Bearer ${grant.token}` } });
        assert.equal(refused.status, 401);
        assert.ok(!(await refused.text()).includes('idleExpiresAt'));
        assert.deepEqual((await client.sessions.listPages(controlled.sessionId)).map((p) => p.pageId), [page.pageId]);
      },
    });
  } finally { await client.sessions.close(controlled.sessionId); }
  for (const [expectedCause, lifetime] of [
    ['ttl_expired', { ttlMs: 1000, idleTimeoutMs: 60_000 }],
    ['idle_expired', { ttlMs: 60_000, idleTimeoutMs: 1000 }],
  ]) {
    const expiring = await client.sessions.create({ tenantId: 'research-smoke', headless: !headed, ...lifetime });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const response = await fetch(`${baseUrl}/v1/sessions/${expiring.sessionId}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(response.status, 404);
    const terminal = (await response.json()).error.details.sessionTerminal;
    assert.equal(terminal.closeCause, expectedCause);
    assert.equal(terminal.leaseRemainingMs, 0);
  }
} catch (error) {
  workflowFailed = true;
  workflowError = error;
}
const cleanup = [];
try {
  fixture.closeAllConnections();
} catch (error) {
  cleanup.push({ status: 'rejected', reason: error });
}
cleanup.push(
  ...(await Promise.allSettled([
    server.close(),
    fixture.listening
      ? new Promise((resolve, reject) =>
          fixture.close((error) => (error ? reject(error) : resolve()))
        )
      : Promise.resolve(),
    rm(directory, { recursive: true, force: true }),
  ]))
);
const failures = cleanup.filter((item) => item.status === 'rejected');
if (failures.length) {
  throw new AggregateError(
    [...(workflowFailed ? [workflowError] : []), ...failures.map((item) => item.reason)],
    'Research smoke cleanup failed'
  );
}
if (workflowFailed) throw workflowError;
console.log(JSON.stringify({ status: 'pass', version, headed, ...provenance,
  measurements, jsonBytes: Buffer.byteLength(json),
  coverage: 'Real Chromium + authenticated REST/SDK/CLI + MCP stdio; captured identity/diagnostics, sampled lease parity, explicit/TTL/idle terminal facts and complete extraction persisted and grepped by this script',
  limits: 'Synthetic local filings; engine-disconnect/window classification, live SEC availability and installed Claude overflow-path qualification are not covered', cleanup: 'owned server, sessions, fixture and files closed' }));
