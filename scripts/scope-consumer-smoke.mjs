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

// One loopback listener answers two host names: 127.0.0.1 is in scope,
// localhost is not. Each hit records the Host header, so a leak is visible.
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
  await new Promise((resolve) => fixture.listen(0, IN_HOST, resolve));
  const port = fixture.address().port;
  const at = (host, path) => `http://${host}:${port}${path}`;
  const baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
  const client = new AgentBrowserClient({ baseUrl, apiKey: key, timeout: 60_000 });
  const { AGENTBROWSER_SESSION_ID: _unused, ...inherited } = process.env;
  const env = { ...inherited, AGENTBROWSER_BASE_URL: baseUrl, AGENTBROWSER_API_KEY: key };

  // 1. The lanes a scope cannot check are refused on every surface.
  const rest = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId: 'scope-smoke', policy: { scope, allowServiceWorkers: true } }),
  });
  const restBody = await rest.json();
  assert.equal(rest.status, 400);
  assert.equal(restBody.error?.details?.rule, 'scope.lane.serviceWorkers');
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
  // The CLI and MCP print the code and message; REST above pins the rule id.
  assert.match(
    cliRefusal.stdout + cliRefusal.stderr,
    /INVALID_REQUEST.*cannot check service-worker/
  );
  check('lanes refused', { rest: rest.status, cli: 'refused' });

  // 2. One scoped session: in scope allowed, out of scope blocked, and a POST
  //    redirected out of scope never leaves (REST, SDK and MCP).
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
        const mcpBlocked = await request('tools/call', {
          name: 'navigate',
          arguments: {
            sessionId: session.sessionId,
            pageId: page.pageId,
            url: at(OUT_HOST, '/never'),
          },
        });
        assert.equal(mcpBlocked.isError, true);
        // Blocked as a policy denial. The SCOPE_* sub-code does not reach the
        // REST/MCP surfaces yet (T10 M2 carries it through); recorded, not assumed.
        const blockedValue = mcpBlocked.structuredContent ?? JSON.parse(mcpBlocked.content[0].text);
        assert.equal(blockedValue.error?.code, 'POLICY_DENIED');
        const outOfScopeReason =
          blockedValue.error?.details?.scope ?? blockedValue.error?.details?.reason;

        await client.sessions
          .navigate(session.sessionId, page.pageId, { url: at(IN_HOST, '/post-out') })
          .catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        assert.ok(hits.some((hit) => hit.method === 'POST' && hit.path === '/hop-out'));
        assert.deepEqual(
          hits.filter((hit) => hit.host === OUT_HOST),
          [],
          'a scoped POST redirect reached the out-of-scope host'
        );
        check('scoped session', {
          inScope: 'success',
          outOfScope: outOfScopeReason,
          postRedirect: 'blocked',
        });
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
