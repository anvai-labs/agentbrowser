// T10 M2: a scoped session records its engagement in a verifiable,
// metadata-only ledger, and the scope fails closed when the ledger fills.
import { chmod, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { RESERVE_BYTES, verifyEngagementLedger } from './engagement-ledger.js';
import { buildServer } from './server.js';
import { AgentBrowserService } from './service.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const engagementDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'engagements-'));
  await chmod(dir, 0o700);
  dirs.push(dir);
  return dir;
};

async function fixture() {
  const server = createServer((request, response) => {
    if (request.url === '/aborter') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        "<html><body><script>const c = new AbortController(); fetch('/slow?token=abort-secret', {method:'POST', body:'y', signal: c.signal}).catch(()=>{}); setTimeout(() => c.abort(), 300);</script></body></html>"
      );
      return;
    }
    if (request.url?.startsWith('/slow')) {
      request.resume();
      return; // never answers
    }
    if (request.url === '/abort-after-hop') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        "<html><body><script>const c = new AbortController(); fetch('/hop307', {method:'POST', body:'y', signal: c.signal}).catch(()=>{}); setTimeout(() => c.abort(), 300);</script></body></html>"
      );
      return;
    }
    if (request.url === '/hop307') {
      request.resume();
      response.writeHead(307, { location: '/stall?token=hop-secret' });
      response.end();
      return;
    }
    if (request.url?.startsWith('/stall')) {
      request.resume();
      return; // never answers
    }
    if (request.url === '/worker-abort') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end("<html><body><script>new Worker('/abort-worker.js')</script></body></html>");
      return;
    }
    if (request.url === '/abort-worker.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(
        "const c = new AbortController(); fetch('/wslow?token=worker-secret', {method:'POST', body:'y', signal: c.signal}).catch(()=>{}); setTimeout(() => c.abort(), 300);"
      );
      return;
    }
    if (request.url?.startsWith('/wslow')) {
      request.resume();
      return; // never answers
    }
    if (request.url === '/form') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<html><body><form id="f" method="post" action="/submit?token=chain-secret"><input name="a" value="1"></form><script>document.getElementById("f").submit()</script></body></html>'
      );
      return;
    }
    if (request.url?.startsWith('/submit')) {
      request.resume();
      response.writeHead(303, { location: '/next' });
      response.end();
      return;
    }
    if (request.url === '/opener') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end("<html><body><script>window.open('/popup-target')</script></body></html>");
      return;
    }
    if (request.url?.startsWith('/redirect-out')) {
      response.writeHead(302, { location: 'http://192.0.2.7:9/never' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><head><link rel="icon" href="data:,"></head><body>in scope</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const readLedger = async (dir: string) => {
  const [tenant] = await readdir(dir);
  const [file] = await readdir(join(dir, tenant!));
  return readFile(join(dir, tenant!, file!), 'utf8');
};

describe('engagement ledger (T10 M2)', () => {
  it('is refused when the operator configured no engagement directory', async () => {
    const app = await buildServer({ engine: new FakeEngine() });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: {
          tenantId: 'one',
          policy: { scope: { allowedHosts: ['a.example'], ledger: true } },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { details: { rule: 'scope.ledger.unconfigured' } },
      });
    } finally {
      await app.close();
    }
  });

  it('records request outcomes, preflight denials and a blocked hop; the chain verifies', async () => {
    const dir = await engagementDir();
    const site = await fixture();
    const service = new AgentBrowserService({
      engine: new PlaywrightChromiumEngine(),
      networkPolicy: new NetworkPolicy({ blockLoopback: false }),
      engagement: { directory: dir, maxBytes: 4 * 1024 * 1024 },
    });
    try {
      const session = await service.createSession({
        tenantId: 'one',
        scope: { allowedHosts: ['127.0.0.1'], ledger: true },
      });
      expect(session.engagementId).toMatch(/^eng_[0-9a-f]{24}$/);
      const { pageId } = await service.createPage(session.sessionId);
      await service.navigate(session.sessionId, pageId, {
        url: site.url('/start?token=query-secret'),
      });
      await expect(
        service.navigate(session.sessionId, pageId, {
          url: 'http://192.0.2.7:9/out?token=preflight-secret',
        })
      ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await service.navigate(session.sessionId, pageId, { url: site.url('/redirect-out') });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await service.closeSession(session.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const text = await readLedger(dir);
      expect(verifyEngagementLedger(text)).toMatchObject({ ok: true, closed: true });
      const records = text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records[0]).toMatchObject({
        type: 'engagement.opened',
        data: { sessionId: session.sessionId },
      });
      expect(
        records.some(
          (r) =>
            r.type === 'request' && r.data.url.endsWith('/start') && r.data.outcome === 'finished'
        )
      ).toBe(true);
      expect(
        records.some((r) => r.type === 'preflight.denied' && r.data.scope === 'SCOPE_HOST_DENIED')
      ).toBe(true);
      expect(
        records.some(
          (r) =>
            r.type === 'request' &&
            r.data.blocked === true &&
            r.data.scope === 'SCOPE_HOST_DENIED' &&
            r.data.redirect
        )
      ).toBe(true);
      expect(records.at(-1)).toMatchObject({
        type: 'engagement.closed',
        data: { dropped: 0, state: 'open' },
      });
      // Metadata only: no query strings.
      expect(text).not.toContain('query-secret');
      expect(text).not.toContain('preflight-secret');
    } finally {
      await service.shutdown().catch(() => {});
      await site.close();
    }
  }, 60_000);

  it('fails the scope closed when the ledger fills', async () => {
    const dir = await engagementDir();
    const site = await fixture();
    const service = new AgentBrowserService({
      engine: new PlaywrightChromiumEngine(),
      networkPolicy: new NetworkPolicy({ blockLoopback: false }),
      engagement: { directory: dir, maxBytes: RESERVE_BYTES + 1500 },
    });
    try {
      const session = await service.createSession({
        tenantId: 'one',
        scope: { allowedHosts: ['127.0.0.1'], ledger: true },
      });
      const { pageId } = await service.createPage(session.sessionId);
      let denied: unknown;
      for (let index = 0; index < 40 && denied === undefined; index += 1) {
        await service
          .navigate(session.sessionId, pageId, { url: site.url(`/p${index}`) })
          .catch((error: unknown) => {
            denied = error;
          });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(denied).toMatchObject({ code: 'POLICY_DENIED' });
      expect(service.getScopeStatus(session.sessionId).denials).toHaveProperty(
        'SCOPE_LEDGER_UNAVAILABLE'
      );
      await service.closeSession(session.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const text = await readLedger(dir);
      expect(verifyEngagementLedger(text)).toMatchObject({ ok: true, closed: true });
      expect(JSON.parse(text.trim().split('\n').at(-1)!).data.state).toBe('full');
    } finally {
      await service.shutdown().catch(() => {});
      await site.close();
    }
  }, 60_000);

  it("records a popup's first navigation (not yet adopted as a page)", async () => {
    const dir = await engagementDir();
    const site = await fixture();
    const service = new AgentBrowserService({
      engine: new PlaywrightChromiumEngine(),
      networkPolicy: new NetworkPolicy({ blockLoopback: false }),
      engagement: { directory: dir, maxBytes: 4 * 1024 * 1024 },
    });
    try {
      const session = await service.createSession({
        tenantId: 'one',
        scope: { allowedHosts: ['127.0.0.1'], ledger: true },
      });
      const { pageId } = await service.createPage(session.sessionId);
      await service.navigate(session.sessionId, pageId, { url: site.url('/opener') });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await service.closeSession(session.sessionId);
      const text = await readLedger(dir);
      expect(verifyEngagementLedger(text)).toMatchObject({ ok: true, closed: true });
      expect(text).toContain('/popup-target');
    } finally {
      await service.shutdown().catch(() => {});
      await site.close();
    }
  }, 60_000);

  it('refuses lanes it cannot record: downloads, and an engine without request recording', async () => {
    const dir = await engagementDir();
    const service = new AgentBrowserService({
      engine: new FakeEngine(),
      engagement: { directory: dir, maxBytes: 4 * 1024 * 1024 },
    });
    try {
      await expect(
        service.createSession({
          tenantId: 'one',
          allowDownloads: true,
          scope: { allowedHosts: ['a.example'], ledger: true },
        })
      ).rejects.toMatchObject({ details: { rule: 'scope.ledger.downloads' } });
      const engine = new FakeEngine();
      const caps = await engine.capabilities();
      engine.capabilities = async () => ({ ...caps, requestRecording: false });
      const blind = new AgentBrowserService({
        engine,
        engagement: { directory: dir, maxBytes: 4 * 1024 * 1024 },
      });
      await expect(
        blind.createSession({
          tenantId: 'one',
          scope: { allowedHosts: ['a.example'], ledger: true },
        })
      ).rejects.toMatchObject({ details: { rule: 'scope.ledger.engine' } });
      await blind.shutdown();
    } finally {
      await service.shutdown().catch(() => {});
    }
  });

  it('records each response of a POST chain: the 303 and its allowed redirect, then the landing', async () => {
    const dir = await engagementDir();
    const site = await fixture();
    const service = new AgentBrowserService({
      engine: new PlaywrightChromiumEngine(),
      networkPolicy: new NetworkPolicy({ blockLoopback: false }),
      engagement: { directory: dir, maxBytes: 4 * 1024 * 1024 },
    });
    try {
      const session = await service.createSession({
        tenantId: 'one',
        scope: { allowedHosts: ['127.0.0.1'], ledger: true },
      });
      const { pageId } = await service.createPage(session.sessionId);
      await service.navigate(session.sessionId, pageId, { url: site.url('/form') }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 800));
      await service.closeSession(session.sessionId);
      const records = (await readLedger(dir))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        records.some(
          (r) =>
            r.type === 'request' &&
            r.data.method === 'POST' &&
            r.data.url.endsWith('/submit') &&
            r.data.status === 303 &&
            String(r.data.redirect).endsWith('/next')
        )
      ).toBe(true);
      expect(
        records.some(
          (r) => r.type === 'request' && r.data.url.endsWith('/next') && r.data.status === 200
        )
      ).toBe(true);
      // The guard's records are origin+path too: no query string.
      expect(JSON.stringify(records)).not.toContain('chain-secret');
      // The passthrough intent is not a record: only outcomes are.
      expect(records.some((r) => r.type === 'request' && r.data.passthrough === true)).toBe(false);
    } finally {
      await service.shutdown().catch(() => {});
      await site.close();
    }
  }, 60_000);

  it('closeSession resolves with the ledger closed, the scope stopped first, and early records flushed', async () => {
    const dir = await engagementDir();
    class RecordingEngine extends FakeEngine {
      override async createSession(options: Parameters<FakeEngine['createSession']>[0]) {
        const session = await super.createSession(options);
        // An outcome reported before the ledger file is open.
        options?.requestRecorder?.({
          type: 'request.finished',
          timestamp: new Date().toISOString(),
          data: { method: 'GET', url: 'https://a.example/early', status: 200 },
        });
        return session;
      }
    }
    const service = new AgentBrowserService({
      engine: new RecordingEngine(),
      engagement: { directory: dir, maxBytes: 4 * 1024 * 1024 },
    });
    try {
      const session = await service.createSession({
        tenantId: 'one',
        scope: { allowedHosts: ['a.example'], ledger: true },
      });
      await service.closeSession(session.sessionId);
      // No wait: closeSession resolves only after the closing record is written.
      const records = (await readLedger(dir))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records.map((r) => r.type)).toEqual([
        'engagement.opened',
        'request',
        'engagement.closed',
      ]);
      expect(records[1].data.url).toBe('https://a.example/early');
      expect(records[2].data.scope.stopped).toBe('session closing');
      // closeSession awaited the close: nothing is still in progress.
      expect(
        (service as unknown as { ledgerClosings: Map<string, unknown> }).ledgerClosings.size
      ).toBe(0);
    } finally {
      await service.shutdown().catch(() => {});
    }
  });

  it('records a POST the page aborts after sending (no response ever arrives)', async () => {
    const dir = await engagementDir();
    const site = await fixture();
    const service = new AgentBrowserService({
      engine: new PlaywrightChromiumEngine(),
      networkPolicy: new NetworkPolicy({ blockLoopback: false }),
      engagement: { directory: dir, maxBytes: 4 * 1024 * 1024 },
    });
    try {
      const session = await service.createSession({
        tenantId: 'one',
        scope: { allowedHosts: ['127.0.0.1'], ledger: true },
      });
      const { pageId } = await service.createPage(session.sessionId);
      await service.navigate(session.sessionId, pageId, { url: site.url('/aborter') });
      await new Promise((resolve) => setTimeout(resolve, 900));
      await service.closeSession(session.sessionId);
      const records = (await readLedger(dir))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        records.some(
          (r) =>
            r.type === 'request' &&
            r.data.method === 'POST' &&
            r.data.url.endsWith('/slow') &&
            r.data.outcome === 'failed'
        )
      ).toBe(true);
      expect(JSON.stringify(records)).not.toContain('abort-secret');
    } finally {
      await service.shutdown().catch(() => {});
      await site.close();
    }
  }, 60_000);

  async function ledgerAfter(path: string) {
    const dir = await engagementDir();
    const site = await fixture();
    const service = new AgentBrowserService({
      engine: new PlaywrightChromiumEngine(),
      networkPolicy: new NetworkPolicy({ blockLoopback: false }),
      engagement: { directory: dir, maxBytes: 4 * 1024 * 1024 },
    });
    try {
      const session = await service.createSession({
        tenantId: 'one',
        scope: { allowedHosts: ['127.0.0.1'], ledger: true },
      });
      const { pageId } = await service.createPage(session.sessionId);
      await service.navigate(session.sessionId, pageId, { url: site.url(path) });
      await new Promise((resolve) => setTimeout(resolve, 900));
      await service.closeSession(session.sessionId);
      const text = await readLedger(dir);
      return {
        text,
        records: text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      };
    } finally {
      await service.shutdown().catch(() => {});
      await site.close();
    }
  }

  it('records an aborted hop after a redirect against that hop, never its query', async () => {
    const { text, records } = await ledgerAfter('/abort-after-hop');
    expect(
      records.some(
        (r) => r.type === 'request' && r.data.url.endsWith('/hop307') && r.data.status === 307
      )
    ).toBe(true);
    expect(
      records.some(
        (r) =>
          r.type === 'request' &&
          r.data.method === 'POST' &&
          r.data.url.endsWith('/stall') &&
          r.data.outcome === 'failed'
      )
    ).toBe(true);
    expect(text).not.toContain('hop-secret');
  }, 60_000);

  it('records an aborted worker POST (its end is unobserved) when the session closes', async () => {
    const { text, records } = await ledgerAfter('/worker-abort');
    expect(
      records.some(
        (r) =>
          r.type === 'request' &&
          r.data.method === 'POST' &&
          r.data.url.endsWith('/wslow') &&
          r.data.outcome === 'failed'
      )
    ).toBe(true);
    expect(text).not.toContain('worker-secret');
  }, 60_000);

  it("an engine crash keeps the engine's close-time records and marks the ledger crashed", async () => {
    const dir = await engagementDir();
    let recorder: ((record: unknown) => void) | undefined;
    class SweepingEngine extends FakeEngine {
      override async createSession(options: Parameters<FakeEngine['createSession']>[0]) {
        const session = await super.createSession(options);
        recorder = options?.requestRecorder as never;
        const close = session.close.bind(session);
        session.close = async () => {
          // What the redirect guard's close sweep does for an unobserved POST.
          recorder?.({
            type: 'request.failed',
            timestamp: new Date().toISOString(),
            data: {
              method: 'POST',
              url: 'https://a.example/hang',
              detail: 'no outcome observed (recorded at close)',
            },
          });
          await close();
        };
        return session;
      }
    }
    const engine = new SweepingEngine();
    const service = new AgentBrowserService({
      engine,
      engagement: { directory: dir, maxBytes: 4 * 1024 * 1024 },
    });
    try {
      const { sessionId } = await service.createSession({
        tenantId: 'one',
        scope: { allowedHosts: ['a.example'], ledger: true },
      });
      const { pageId } = await service.createPage(sessionId);
      const ids = engine.getSessionIds();
      engine.getFakePage(ids[ids.length - 1]!, pageId)?.crash();
      await service.observe(sessionId, pageId, {}).catch(() => {});
      const records = (await readLedger(dir))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records.map((r) => r.type)).toEqual([
        'engagement.opened',
        'request',
        'engagement.closed',
      ]);
      expect(records[1].data.url).toBe('https://a.example/hang');
      expect(records[2].data).toMatchObject({
        crashed: true,
        scope: { stopped: 'engine crashed' },
      });
    } finally {
      await service.shutdown().catch(() => {});
    }
  });

  it('shutdown during crash recovery waits for the crashed ledger to close', async () => {
    const dir = await engagementDir();
    class SlowCloseEngine extends FakeEngine {
      override async createSession(options: Parameters<FakeEngine['createSession']>[0]) {
        const session = await super.createSession(options);
        const close = session.close.bind(session);
        session.close = async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          await close();
        };
        return session;
      }
    }
    const engine = new SlowCloseEngine();
    // A slow ledger close: a shutdown that does not wait for it reads an unclosed file.
    const { EngagementLedger } = await import('./engagement-ledger.js');
    const realClose = EngagementLedger.prototype.close;
    EngagementLedger.prototype.close = async function (
      this: InstanceType<typeof EngagementLedger>,
      data
    ) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return realClose.call(this, data);
    };
    const restore = () => {
      EngagementLedger.prototype.close = realClose;
    };
    const service = new AgentBrowserService({
      engine,
      engagement: { directory: dir, maxBytes: 4 * 1024 * 1024 },
    });
    const { sessionId } = await service.createSession({
      tenantId: 'one',
      scope: { allowedHosts: ['a.example'], ledger: true },
    });
    const { pageId } = await service.createPage(sessionId);
    const ids = engine.getSessionIds();
    engine.getFakePage(ids[ids.length - 1]!, pageId)?.crash();
    const recovering = service.observe(sessionId, pageId, {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    await service.shutdown().catch(() => {});
    // No wait after shutdown: the crashed ledger is already closed.
    const records = (await readLedger(dir))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    try {
      expect(records.at(-1)).toMatchObject({ type: 'engagement.closed', data: { crashed: true } });
    } finally {
      restore();
      await recovering;
    }
  });
});
