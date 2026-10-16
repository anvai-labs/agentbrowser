/** Build first. Engagement-scope release smoke (T10 M1): one scoped session, every surface. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConsumerSmokeRuntime } from './consumer-smoke-runtime.mjs';
import { checkMcp, runExecutable } from './release-smoke.mjs';

const runtime = await loadConsumerSmokeRuntime();
const {
  version,
  buildServer,
  PlaywrightChromiumEngine,
  NetworkPolicy,
  cliCommand,
  mcpCommand,
  provenance,
} = runtime;
const { AgentBrowserClient } = runtime.sdk;

// One listener answers two host names: 127.0.0.1 is in scope, localhost is
// not. It listens on both address families, so localhost reaches it whether
// it resolves to 127.0.0.1 or ::1, and each hit records the Host header: a
// leak is observable, and a control request proves the host is reachable.
const IN_HOST = '127.0.0.1';
const OUT_HOST = 'localhost';
const hits = [];
const fixture = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const host = (request.headers.host ?? '').replace(/:\d+$/, '');
    const url = new URL(request.url ?? '/', 'http://fixture');
    hits.push({ host, method: request.method, path: url.pathname });
    const port = fixture.address().port;
    if (url.pathname === '/hop-out') {
      response.writeHead(307, { location: `http://${OUT_HOST}:${port}/leaked` });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      url.pathname === '/post-out'
        ? `<form id="f" method="post" action="/hop-out"><input type="hidden" name="blob" value="${'x'.repeat(50_000)}"></form><script>document.getElementById('f').submit()</script>`
        : '<!doctype html><h1>in scope</h1>'
    );
  });
});
const listen = (host) =>
  new Promise((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, host, () => {
      fixture.off('error', reject);
      resolve();
    });
  });

const waitFor = async (predicate, timeoutMs, message) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const key = randomUUID();
const server = await buildServer({
  engine: new PlaywrightChromiumEngine(),
  networkPolicy: new NetworkPolicy({ blockLoopback: false }),
  apiKeys: new Map([[createHash('sha256').update(key).digest('hex'), 'scope-smoke']]),
});
const scope = { allowedHosts: [IN_HOST] };
const checks = [];
const check = (name, value) => {
  checks.push({ name, ...value });
  console.log(JSON.stringify({ check: checks.at(-1) }));
};
const scratch = await mkdtemp(join(tmpdir(), 'scope-smoke-'));
try {
  await listen('::').catch(() => listen(IN_HOST));
  const port = fixture.address().port;
  const at = (host, path) => `http://${host}:${port}${path}`;
  const baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
  const client = new AgentBrowserClient({ baseUrl, apiKey: key, timeout: 60_000 });
  const { AGENTBROWSER_SESSION_ID: _unused, ...inherited } = process.env;
  const env = { ...inherited, AGENTBROWSER_BASE_URL: baseUrl, AGENTBROWSER_API_KEY: key };
  const restCreate = async (body) => {
    const response = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'scope-smoke', ...body }),
    });
    return { status: response.status, body: await response.json() };
  };

  // 0. Control: the out-of-scope host name reaches the fixture.
  await fetch(at(OUT_HOST, '/control'));
  assert.ok(
    hits.some((hit) => hit.host === OUT_HOST && hit.path === '/control'),
    'control: the out-of-scope host must be reachable for the leak check to mean anything'
  );

  // 1. Every lane a scope cannot check is refused (REST pins the rule ids).
  const serviceWorkers = await restCreate({ policy: { scope, allowServiceWorkers: true } });
  assert.equal(serviceWorkers.status, 400);
  assert.equal(serviceWorkers.body.error?.details?.rule, 'scope.lane.serviceWorkers');
  const attach = await restCreate({ cdpAttach: true, policy: { scope } });
  assert.equal(attach.status, 400);
  assert.equal(attach.body.error?.details?.rule, 'floor.cdp.options');
  const topLevel = await restCreate({ scope });
  assert.equal(topLevel.status, 400);
  assert.equal(topLevel.body.error?.code, 'INVALID_REQUEST');
  const scopeFile = join(scratch, 'scope.json');
  await writeFile(scopeFile, JSON.stringify(scope));
  const cliRefusal = await runExecutable(
    [
      ...cliCommand,
      '--base-url',
      baseUrl,
      '--json',
      'session',
      'create',
      '--tenant',
      'scope-smoke',
      '--scope-file',
      scopeFile,
      '--allow-service-workers',
    ],
    { env, timeoutMs: 60_000, expectedExitCode: 1 }
  );
  // The CLI and MCP print the code and message, not the rule id.
  assert.match(
    cliRefusal.stdout + cliRefusal.stderr,
    /INVALID_REQUEST.*cannot check service-worker/
  );
  check('lanes refused', {
    restServiceWorkers: serviceWorkers.status,
    restCdpAttach: attach.status,
    restTopLevelScope: topLevel.status,
    cliServiceWorkers: 'refused',
  });

  // 2. One scoped session: each surface's view of an out-of-scope navigation,
  //    then a form POST redirected out of scope.
  const session = await client.sessions.create({ tenantId: 'scope-smoke', policy: { scope } });
  const page = await client.sessions.createPage(session.sessionId);
  try {
    await checkMcp(mcpCommand, {
      expectedVersion: version,
      env,
      timeoutMs: 600_000,
      async exercise({ request }) {
        const mcpRefusal = await request('tools/call', {
          name: 'create',
          arguments: { tenantId: 'scope-smoke', scope, allowServiceWorkers: true },
        });
        assert.equal(mcpRefusal.isError, true);
        assert.match(JSON.stringify(mcpRefusal), /cannot check service-worker/);

        const allowed = await client.sessions.navigate(session.sessionId, page.pageId, {
          url: at(IN_HOST, '/start'),
        });
        assert.equal(allowed.status, 'success');

        // REST and SDK carry the scope sub-code; CLI and MCP project only the
        // bounded reason (T10 M2 closes that gap). Each is a policy denial.
        const out = at(OUT_HOST, '/never');
        const restNavigate = await fetch(
          `${baseUrl}/v1/sessions/${session.sessionId}/pages/${page.pageId}/navigate`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ url: out }),
          }
        );
        const restDenial = (await restNavigate.json()).error;
        assert.equal(restDenial?.code, 'POLICY_DENIED');
        assert.equal(restDenial?.details?.scope, 'SCOPE_HOST_DENIED');
        const sdkDenial = await client.sessions
          .navigate(session.sessionId, page.pageId, { url: out })
          .then(
            () => assert.fail('SDK navigate out of scope succeeded'),
            (error) => error
          );
        assert.equal(sdkDenial.code, 'POLICY_DENIED');
        assert.equal(sdkDenial.details?.scope, 'SCOPE_HOST_DENIED');
        const mcpBlocked = await request('tools/call', {
          name: 'navigate',
          arguments: { sessionId: session.sessionId, pageId: page.pageId, url: out },
        });
        assert.equal(mcpBlocked.isError, true);
        const mcpDenial = (mcpBlocked.structuredContent ?? JSON.parse(mcpBlocked.content[0].text))
          .error;
        assert.equal(mcpDenial?.code, 'POLICY_DENIED');
        const cliNavigate = await runExecutable(
          [
            ...cliCommand,
            '--base-url',
            baseUrl,
            '--json',
            'navigate',
            session.sessionId,
            page.pageId,
            out,
          ],
          { env, timeoutMs: 60_000, expectedExitCode: 1 }
        );
        const cliDenial = JSON.parse(cliNavigate.stdout.trim() || cliNavigate.stderr.trim()).error;
        assert.equal(cliDenial?.code, 'POLICY_DENIED');
        assert.ok(
          !hits.some((hit) => hit.path === '/never'),
          'an out-of-scope navigation reached the wire'
        );
        check('out-of-scope navigation', {
          rest: restDenial.details.scope,
          sdk: sdkDenial.details.scope,
          mcp: mcpDenial.details?.scope ?? mcpDenial.details?.reason,
          cli: cliDenial.details?.scope ?? cliDenial.details?.reason,
        });

        await client.sessions
          .navigate(session.sessionId, page.pageId, { url: at(IN_HOST, '/post-out') })
          .catch(() => {});
        await waitFor(
          () => hits.some((hit) => hit.method === 'POST' && hit.path === '/hop-out'),
          15_000,
          'the scoped form POST never reached the in-scope host'
        );
        // Grace for a follow-up the browser would send at once if unchecked.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        assert.deepEqual(
          hits.filter((hit) => hit.host === OUT_HOST && hit.path !== '/control'),
          [],
          'a scoped POST redirect reached the out-of-scope host'
        );
        // The blocked hop is recorded as a blocked request.failed event.
        const replay = await fetch(
          `${baseUrl}/v1/sessions/${session.sessionId}/events/replay?type=request.failed`,
          { headers: { authorization: `Bearer ${key}` } }
        );
        const events = JSON.stringify(await replay.json());
        assert.match(events, /"blocked":true/);
        assert.match(events, /"redirect":"http:\/\/localhost:\d+\/leaked"/);
        check('post redirect out of scope', { leaked: false, recorded: 'request.failed' });
      },
    });
  } finally {
    await client.sessions.close(session.sessionId);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
  await server.close();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
}
console.log(
  JSON.stringify({
    status: 'pass',
    version,
    ...provenance,
    checks,
    limits: 'Local fixtures only; scope enforcement is application-layer (not OS-enforced, N2).',
  })
);
