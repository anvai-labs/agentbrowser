// T10 M1: redirects that follow a body-bearing request (POST/PUT/PATCH) are
// checked hop by hop (real Chromium, local fixtures only). Those requests
// pass to the browser natively (route.continue keeps upload bodies
// byte-exact), and Playwright never routes the redirected follow-up, so
// before this guard a 307 re-sent the body to any host. The fixture serves
// both hosts from one loopback listener: `127.0.0.1` is in scope and
// `localhost` is out of scope, told apart by the Host header the browser
// sends. Each hit records that host, so a leak is directly observable.
import { createServer, type Server } from 'node:http';
import type { EnginePage, RequestPolicy } from '@agentbrowser/engine';
import { EngagementScopePolicy, NetworkPolicy } from '@agentbrowser/policy';
import { describe, expect, it } from 'vitest';
import { BodyRedirectGuard, followMethod } from './body-redirect-guard.js';
import { PlaywrightChromiumEngine } from './index.js';

const IN_HOST = '127.0.0.1';
const OUT_HOST = 'localhost';
const BODY_BYTES = 200_000;

interface Hit {
  host: string;
  method: string;
  path: string;
  bytes: number;
}

interface Fixture {
  hits: Hit[];
  server: Server;
  url: (path: string) => string;
  /** Hits that reached the out-of-scope host name. */
  leaked: () => Hit[];
}

const autoPost = (action: string, method = 'POST'): string =>
  method === 'POST'
    ? `<form id="f" method="post" action="${action}"><input type="hidden" name="blob" value="${'x'.repeat(BODY_BYTES)}"></form>` +
      `<script>document.getElementById('f').submit()</script>`
    : `<script>fetch('${action}', {method: '${method}', body: '${'y'.repeat(1000)}'}).catch(function(){})</script>`;

function startFixture(): Promise<Fixture> {
  const hits: Hit[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const host = (request.headers.host ?? '').split(':')[0] ?? '';
      const url = new URL(request.url ?? '/', 'http://fixture');
      const bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      hits.push({ host, method: request.method ?? 'GET', path: url.pathname, bytes });
      const port = (server.address() as { port: number }).port;
      // Permissive CORS so a script's cross-host redirect is actually followed
      // by the browser; without it CORS, not the guard, would stop the leak.
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader('access-control-allow-methods', 'PUT, PATCH, POST');
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
      const target = (name: string | null, path: string) =>
        `http://${name === 'out' ? OUT_HOST : IN_HOST}:${port}${path}`;
      // /hop/<status>?to=in|out&next=<path> answers with that redirect.
      const hop = /^\/hop\/(\d{3})$/.exec(url.pathname);
      if (hop) {
        response.writeHead(Number(hop[1]), {
          location: target(url.searchParams.get('to'), url.searchParams.get('next') ?? '/landed'),
        });
        response.end();
        return;
      }
      if (url.pathname === '/worker.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(
          `fetch('${url.searchParams.get('action') ?? '/'}', {method: 'POST', body: 'z'}).catch(function(){})`
        );
        return;
      }
      if (url.pathname === '/worker-page') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          `<html><body><script>new Worker('/worker.js?action=${encodeURIComponent(url.searchParams.get('action') ?? '/')}')</script></body></html>`
        );
        return;
      }
      if (url.pathname === '/framed') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          `<html><body><iframe src="/auto/POST?action=${encodeURIComponent(url.searchParams.get('action') ?? '/')}"></iframe></body></html>`
        );
        return;
      }
      const page = /^\/auto\/(POST|PUT|PATCH)$/.exec(url.pathname);
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        `<html><head><link rel="icon" href="data:,"></head><body><h1>fixture</h1>${
          page ? autoPost(url.searchParams.get('action') ?? '/', page[1]) : ''
        }</body></html>`
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        hits,
        server,
        url: (path) => `http://${IN_HOST}:${port}${path}`,
        leaked: () => hits.filter((hit) => hit.host === OUT_HOST),
      });
    });
  });
}

const closeFixture = async (fixture: Fixture): Promise<void> => {
  fixture.server.closeAllConnections();
  await new Promise<void>((done) => fixture.server.close(() => done()));
};

const scoped = (): EngagementScopePolicy =>
  new EngagementScopePolicy(new NetworkPolicy({ blockLoopback: false }), {
    allowedHosts: [IN_HOST],
  });

async function withPage(
  policy: RequestPolicy,
  run: (page: EnginePage, failures: Array<Record<string, unknown>>) => Promise<void>
): Promise<void> {
  const engine = new PlaywrightChromiumEngine();
  try {
    const session = await engine.createSession({ headless: true, requestPolicy: policy });
    const page = await session.newPage();
    const failures: Array<Record<string, unknown>> = [];
    const collector = (async () => {
      for await (const event of page.events()) {
        if (event.type === 'request.failed') {
          failures.push((event.data ?? {}) as Record<string, unknown>);
        }
      }
    })();
    collector.catch(() => {});
    await run(page, failures);
  } finally {
    await engine.close();
  }
}

/** Submit through a fixture page, then let the browser follow (or not). */
async function submit(page: EnginePage, fixture: Fixture, action: string, method = 'POST') {
  // The page submits itself during load, so a blocked hop can surface as a
  // failed navigation; the fixture's hit log is the evidence either way.
  await page
    .navigate({ url: fixture.url(`/auto/${method}?action=${encodeURIComponent(action)}`) })
    .catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

const hopTo = (status: number, to: 'in' | 'out', next = '/landed') =>
  `/hop/${status}?to=${to}&next=${encodeURIComponent(next)}`;

describe('redirects after body-bearing requests are checked (T10 M1, real Chromium)', () => {
  it('a 307 from an in-scope POST to an out-of-scope host is blocked: the body never leaves scope', async () => {
    const fixture = await startFixture();
    try {
      await withPage(scoped(), async (page, failures) => {
        await submit(page, fixture, hopTo(307, 'out'));
        expect(fixture.hits.some((hit) => hit.method === 'POST' && hit.path === '/hop/307')).toBe(
          true
        );
        expect(fixture.leaked()).toEqual([]);
        expect(failures.some((failure) => failure.blocked === true && failure.redirect)).toBe(true);
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('a 303 from an in-scope POST to an out-of-scope host is blocked: no GET reaches it', async () => {
    const fixture = await startFixture();
    try {
      await withPage(scoped(), async (page) => {
        await submit(page, fixture, hopTo(303, 'out'));
        expect(fixture.leaked()).toEqual([]);
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('every hop of the chain is checked: in-scope 303, then a 302 out of scope, is blocked', async () => {
    const fixture = await startFixture();
    try {
      await withPage(scoped(), async (page) => {
        await submit(page, fixture, hopTo(303, 'in', hopTo(302, 'out')));
        expect(fixture.hits.some((hit) => hit.host === IN_HOST && hit.path === '/hop/302')).toBe(
          true
        );
        expect(fixture.leaked()).toEqual([]);
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('an in-scope 307 completes and re-sends the body byte-for-byte', async () => {
    const fixture = await startFixture();
    try {
      await withPage(scoped(), async (page) => {
        await submit(page, fixture, hopTo(307, 'in'));
        const first = fixture.hits.find((hit) => hit.path === '/hop/307');
        const landed = fixture.hits.find((hit) => hit.path === '/landed');
        expect(first?.bytes).toBeGreaterThan(BODY_BYTES);
        expect(landed).toMatchObject({ host: IN_HOST, method: 'POST', bytes: first?.bytes });
        expect((await page.observe({ mode: 'interactive' })).url).toContain('/landed');
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  // Under Playwright routing Chromium already fails a script fetch whose
  // redirect crosses origins (ERR_FAILED), so this pins that nothing reaches
  // the out-of-scope host for script PUT/PATCH, guard or not.
  it('script PUT and PATCH redirected out of scope never reach it', async () => {
    const fixture = await startFixture();
    try {
      await withPage(scoped(), async (page) => {
        await submit(page, fixture, hopTo(307, 'out'), 'PUT');
        await submit(page, fixture, hopTo(308, 'out'), 'PATCH');
        expect(fixture.hits.filter((hit) => hit.path.startsWith('/hop/')).length).toBe(2);
        expect(fixture.leaked()).toEqual([]);
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('a form POST inside a child frame is guarded the same way', async () => {
    const fixture = await startFixture();
    try {
      await withPage(scoped(), async (page) => {
        await page.navigate({
          url: fixture.url(`/framed?action=${encodeURIComponent(hopTo(307, 'out'))}`),
        });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(fixture.hits.some((hit) => hit.method === 'POST' && hit.path === '/hop/307')).toBe(
          true
        );
        expect(fixture.leaked()).toEqual([]);
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('a dedicated worker POST redirected out of scope is blocked too', async () => {
    const fixture = await startFixture();
    try {
      await withPage(scoped(), async (page) => {
        await page.navigate({
          url: fixture.url(`/worker-page?action=${encodeURIComponent(hopTo(307, 'out'))}`),
        });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(fixture.hits.some((hit) => hit.method === 'POST' && hit.path === '/hop/307')).toBe(
          true
        );
        expect(fixture.leaked()).toEqual([]);
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('a hostile chain past the hop cap is blocked', async () => {
    const fixture = await startFixture();
    try {
      await withPage(scoped(), async (page) => {
        let chain = '/landed';
        for (let index = 0; index < 11; index += 1) chain = hopTo(307, 'in', chain);
        await submit(page, fixture, chain);
        expect(fixture.hits.some((hit) => hit.path === '/landed')).toBe(false);
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);
});

describe('BodyRedirectGuard unit rules', () => {
  const fakeContext = () => {
    const handlers = new Map<string, Array<(value: unknown) => void>>();
    return {
      on: (event: string, handler: (value: unknown) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      pages: () => [],
      newCDPSession: async () => {
        throw new Error('no CDP');
      },
    };
  };

  it('refuses to claim a body-bearing request it did not see (fail closed)', () => {
    const guard = new BodyRedirectGuard(fakeContext() as never, {
      verdictOf: async () => ({ verdict: 'allow' }),
      onBlocked: () => {},
      maxHops: 10,
    });
    const page = {};
    const request = {
      frame: () => ({ page: () => page }),
      method: () => 'POST',
      url: () => 'http://127.0.0.1/form',
      headers: () => ({}),
    };
    expect(guard.track(request as never)).toBe(false);
    const workerRequest = {
      ...request,
      frame: () => {
        throw new Error('no frame');
      },
    };
    expect(guard.track(workerRequest as never)).toBe(false);
  });

  it("follows the browser's method rules for each redirect status", () => {
    expect(followMethod(307, 'POST')).toBe('POST');
    expect(followMethod(308, 'PATCH')).toBe('PATCH');
    expect(followMethod(303, 'PUT')).toBe('GET');
    expect(followMethod(302, 'POST')).toBe('GET');
    expect(followMethod(301, 'PUT')).toBe('PUT');
  });
});
