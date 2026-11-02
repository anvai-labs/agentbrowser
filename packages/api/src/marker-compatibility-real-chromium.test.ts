// T10 A8/A9: captcha-shaped iframe/API traffic, local receivers only.
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyEngagementLedger } from '@agentbrowser/core';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import type { BrowserContext, CDPSession } from 'playwright';
import { expect, it, vi } from 'vitest';
import { BodyRedirectGuard } from '../../engine-playwright/src/body-redirect-guard.js';
import { AgentBrowserService } from './service.js';

type Restriction = 'method' | 'host' | 'rate' | 'budget';
type Hit = {
  path: string;
  method: string;
  host: string;
  marker: string | undefined;
  origin: string | undefined;
  requestedMethod: string | undefined;
  body: string;
};
const payload = JSON.stringify({ sitekey: 'fixture', action: 'challenge', text: 'é🚀' });
const protocolEvidence = join(tmpdir(), `marker-compat-protocol-${process.pid}.jsonl`);

async function listen(server: Server, hostname = '127.0.0.1', port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, resolve);
  });
  return (server.address() as { port: number }).port;
}

async function run(markers: boolean, restriction?: Restriction, scoped = true) {
  const hits: Hit[] = [];
  const observed: Array<Record<string, unknown>> = [];
  // Observe the real guard's own protocol events without installing another
  // interceptor or changing a verdict. This qualifies genuine preflight metadata.
  const guardPrototype = BodyRedirectGuard.prototype as unknown as {
    attach(open: () => Promise<CDPSession>): Promise<unknown>;
  };
  const originalAttach = guardPrototype.attach;
  const capture = vi.spyOn(guardPrototype, 'attach').mockImplementation(function (
    this: typeof guardPrototype,
    open
  ) {
    return originalAttach.call(this, async () => {
      const cdp = await open();
      cdp.on('Fetch.requestPaused', (event) => {
        if (event.request.url.endsWith('/challenge') && observed.length < 256)
          observed.push({
            domain: 'Fetch',
            method: event.request.method,
            resourceType: event.resourceType,
            frameId: event.frameId,
            networkId: event.networkId,
            status: event.responseStatusCode,
            error: event.responseErrorReason,
          });
      });
      cdp.on('Network.requestWillBeSent', (event) => {
        if (event.request.url.endsWith('/challenge') && observed.length < 256)
          observed.push({
            domain: 'Network',
            method: event.request.method,
            resourceType: event.type,
            frameId: event.frameId,
            networkId: event.requestId,
            loaderId: event.loaderId,
            initiatorType: event.initiator.type,
            initiatorRequestId: event.initiator.requestId,
          });
      });
      cdp.on('Network.loadingFailed', (event) => {
        if (observed.length < 256)
          observed.push({
            domain: 'failure',
            networkId: event.requestId,
            error: event.errorText,
            cors: event.corsErrorStatus?.corsError,
          });
      });
      return cdp;
    });
  });
  const handler: RequestListener = (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      hits.push({
        path: request.url ?? '/',
        method: request.method ?? 'GET',
        host: request.headers.host ?? '',
        marker: request.headers['x-hackerone-research'] as string | undefined,
        origin: request.headers.origin,
        requestedMethod: request.headers['access-control-request-method'] as string | undefined,
        body: Buffer.concat(chunks).toString(),
      });
      response.setHeader('access-control-allow-origin', request.headers.origin ?? '*');
      response.setHeader('access-control-allow-credentials', 'true');
      response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
      response.setHeader('access-control-allow-headers', 'content-type');
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
      } else {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ challenge: 'completed' }));
      }
    });
  };
  // Native Chromium and Node's inspected lane can prefer different localhost
  // address families. Both receivers stay loopback-only at the same port.
  const api = createServer(handler);
  const apiIpv4 = createServer(handler);
  const apiPort = await listen(api, '::1');
  await listen(apiIpv4, '127.0.0.1', apiPort);
  let appPort = 0;
  const app = createServer((request, response) => {
    const path = request.url ?? '/';
    hits.push({
      path,
      method: request.method ?? 'GET',
      host: request.headers.host ?? '',
      marker: request.headers['x-hackerone-research'] as string | undefined,
      origin: request.headers.origin,
      requestedMethod: undefined,
      body: '',
    });
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (path === '/') {
      // The host-denied case must still load its driver before the API refusal.
      const host = restriction === 'host' ? '127.0.0.1' : 'localhost';
      response.end(
        `<link rel=icon href=data:,><script>addEventListener('message',event=>{if(event.data==='challenge-completed')document.title='challenge-completed';else if(event.data?.kind==='challenge-error')document.title='challenge-error:'+event.data.message;});</script><iframe allow="local-network-access; local-network; loopback-network" src="http://${host}:${appPort}/frame"></iframe>`
      );
    } else if (path === '/frame') {
      // Positive JSON traffic exercises genuine browser preflights. Simple POST
      // denial controls ensure policy, rather than CORS, stops the API receiver.
      const contentType = restriction ? 'text/plain' : 'application/json';
      response.end(`<link rel=icon href=data:,><script>(async()=>{
        try {
          const response = await fetch('http://localhost:${apiPort}/challenge', {
            method:'POST', credentials:'include',
            headers:{'Content-Type':${JSON.stringify(contentType)}},
            body:${JSON.stringify(payload)}
          });
          const data = await response.json();
          if(response.status===200 && data.challenge==='completed') {
            await (await fetch('/complete')).text();
            parent.postMessage('challenge-completed','*');
          }
        } catch (error) { parent.postMessage({kind:'challenge-error',message:String(error)},'*'); }
      })()</script>`);
    } else {
      response.end('completed');
    }
  });
  appPort = await listen(app);
  const directory = await mkdtemp(join(tmpdir(), 'marker-compatibility-'));
  const engine = new PlaywrightChromiumEngine();
  const createSession = engine.createSession.bind(engine);
  const fixturePermission = vi
    .spyOn(engine, 'createSession')
    .mockImplementation(async (options) => {
      const session = await createSession(options);
      // This fresh local fixture requires Chromium's native localhost permission.
      // The application egress/scope/DNS/ledger guards remain unchanged, including
      // all four zero-receiver denial controls below. No product flag is added.
      const context = (session as unknown as { context: BrowserContext }).context;
      try {
        for (const origin of [`http://127.0.0.1:${appPort}`, `http://localhost:${appPort}`])
          await context.grantPermissions(['local-network-access'], { origin });
        return session;
      } catch (error) {
        await session.close();
        throw error;
      }
    });
  const service = new AgentBrowserService({
    engine,
    networkPolicy: new NetworkPolicy({ blockLoopback: false }),
    engagement: { directory },
  });
  try {
    const creation = {
      tenantId: 'marker-compatibility',
      scope: {
        allowedHosts: restriction === 'host' ? ['127.0.0.1'] : ['127.0.0.1', 'localhost'],
        allowedMethods: restriction === 'method' ? ['GET', 'OPTIONS'] : ['GET', 'POST', 'OPTIONS'],
        requestBudget: restriction === 'budget' ? 2 : 100,
        ...(restriction === 'rate' ? { rateLimit: { requests: 2, perSeconds: 3600 } } : {}),
        ...(markers
          ? {
              requestHeaders: [
                { header: 'X-HackerOne-Research', value: 'researcher', hostSuffix: '127.0.0.1' },
              ],
              identityBindings: [
                {
                  header: 'X-HackerOne-Research',
                  value: 'researcher',
                  allowedHosts: ['127.0.0.1'],
                },
              ],
            }
          : {}),
        ledger: true,
      },
    };
    const session = await service.createSession(
      scoped ? creation : { tenantId: 'marker-compatibility' }
    );
    const page = await service.createPage(session.sessionId);
    await service.navigate(session.sessionId, page.pageId, {
      url: `http://127.0.0.1:${appPort}/`,
      waitUntil: 'domcontentloaded',
    });
    const code = restriction
      ? {
          method: 'SCOPE_METHOD_DENIED',
          host: 'SCOPE_HOST_DENIED',
          rate: 'SCOPE_RATE_LIMITED',
          budget: 'SCOPE_BUDGET_EXHAUSTED',
        }[restriction]
      : undefined;
    let completed = false;
    let lastTitle: string | undefined;
    if (code) {
      await vi.waitFor(
        () => expect(service.getScopeStatus(session.sessionId).denials[code]).toBeGreaterThan(0),
        { timeout: 10000 }
      );
    } else {
      try {
        await expect
          .poll(
            async () => {
              lastTitle = (await service.observe(session.sessionId, page.pageId, {})).title;
              return lastTitle;
            },
            {
              timeout: 10000,
            }
          )
          .toBe('challenge-completed');
        completed = true;
      } catch {
        // Return receiver and sealed-ledger evidence for the positive assertion.
      }
    }
    const denials = scoped ? service.getScopeStatus(session.sessionId).denials : {};
    await service.closeSession(session.sessionId);
    let records: Array<{ type: string; data: Record<string, unknown> }> = [];
    if (session.engagementId) {
      const ledgerFile = await service.engagementLedgerFile(
        'marker-compatibility',
        session.engagementId
      );
      const ledger = await readFile(ledgerFile.path, 'utf8');
      expect(verifyEngagementLedger(ledger)).toMatchObject({ ok: true, closed: true });
      records = ledger
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    }
    await appendFile(
      protocolEvidence,
      `${JSON.stringify({ markers, restriction, scoped, completed, lastTitle, observed, denials, hits, ledgerSealed: Boolean(session.engagementId) })}\n`,
      { mode: 0o600 }
    );
    return { hits, denials, records, apiPort, appPort, code, completed, lastTitle, observed };
  } finally {
    await service.shutdown();
    await engine.close();
    for (const server of [app, api, apiIpv4]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
    capture.mockRestore();
    fixturePermission.mockRestore();
  }
}

it.each([false, true])(
  'completes cross-origin iframe JSON challenge traffic (markers=%s)',
  async (markers) => {
    const { hits, records, denials, apiPort, appPort, completed, lastTitle, observed } =
      await run(markers);
    const failures = records.filter(
      (record) => record.type === 'request' && record.data.outcome === 'failed'
    );
    expect(
      completed,
      JSON.stringify({ hits, failures, lastTitle, observed, protocolEvidence })
    ).toBe(true);
    expect(denials).toEqual({});
    const apiHits = hits.filter(({ host }) => host === `localhost:${apiPort}`);
    // Playwright routing fulfills genuine browser preflights internally. The
    // application POST must reach the receiver; preflight provenance is CDP.
    expect(apiHits.map(({ method }) => method)).toEqual(['POST']);
    expect(apiHits[0]).toMatchObject({
      body: payload,
      marker: undefined,
      origin: `http://localhost:${appPort}`,
    });
    const preflight = observed.find(
      (event) =>
        event.domain === 'Network' &&
        event.method === 'OPTIONS' &&
        event.initiatorType === 'preflight'
    );
    expect(preflight).toBeDefined();
    expect(observed).toContainEqual(
      expect.objectContaining({
        domain: 'Fetch',
        method: 'OPTIONS',
        networkId: preflight?.networkId,
      })
    );
    expect(
      hits.every(
        (hit) =>
          hit.marker === (markers && hit.host.startsWith('127.0.0.1:') ? 'researcher' : undefined)
      )
    ).toBe(true);
    const injections = records.filter((record) => record.type === 'request.headersInjected');
    expect(injections.length > 0).toBe(markers);
    expect(injections.every((record) => record.data.hostname === '127.0.0.1')).toBe(true);
    expect(failures).toEqual([]);
  },
  60000
);

it('qualifies the unscoped fixture control before attributing failures to scope interception', async () => {
  const { completed, lastTitle, hits, apiPort } = await run(false, undefined, false);
  expect(completed, JSON.stringify({ hits, lastTitle })).toBe(true);
  expect(
    hits.filter(({ host }) => host === `localhost:${apiPort}`).map(({ method }) => method)
  ).toEqual(['POST']);
}, 60000);

it.each(['method', 'host', 'rate', 'budget'] as const)(
  'keeps %s refusal enforced and ledgered without a dependency receiver hit',
  async (restriction) => {
    const { hits, records, code } = await run(true, restriction);
    expect(hits.filter(({ path }) => path === '/challenge')).toEqual([]);
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'request',
        data: expect.objectContaining({ method: 'POST', outcome: 'failed', scope: code }),
      })
    );
  },
  60000
);
