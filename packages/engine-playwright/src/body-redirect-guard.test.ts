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
import {
  BodyRedirectGuard,
  type BodyRedirectGuardOptions,
  followMethod,
} from './body-redirect-guard.js';
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
        // `suffix` makes Chromium's follow-up URL differ from the Location
        // text (a fragment is stripped, `|` is re-encoded).
        response.writeHead(Number(hop[1]), {
          location:
            target(url.searchParams.get('to'), url.searchParams.get('next') ?? '/landed') +
            (url.searchParams.get('suffix') ?? ''),
        });
        response.end();
        return;
      }
      // Two chains converge on /shared: the frame's ends here, the
      // document's is sent out of scope.
      if (url.pathname === '/converge') {
        const delay = Number(url.searchParams.get('delay') ?? '0');
        setTimeout(() => {
          response.writeHead(307, { location: target('in', '/shared') });
          response.end();
        }, delay);
        return;
      }
      if (url.pathname === '/shared') {
        if (request.headers['sec-fetch-dest'] === 'iframe') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('frame done');
        } else {
          response.writeHead(307, { location: target('out', '/leak-shared') });
          response.end();
        }
        return;
      }
      if (url.pathname === '/two-chains') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          `<html><body><iframe src="/auto/POST?action=${encodeURIComponent('/converge?delay=300')}"></iframe>` +
            `<form id="f" method="post" action="/converge?delay=50"><input type="hidden" name="b" value="1"></form>` +
            `<script>setTimeout(function(){document.getElementById('f').submit()}, 200)</script></body></html>`
        );
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
      if (url.pathname === '/loop/a' || url.pathname === '/loop/b') {
        response.writeHead(307, {
          location: target('in', url.pathname === '/loop/a' ? '/loop/b' : '/loop/a'),
        });
        response.end();
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

const hopTo = (status: number, to: 'in' | 'out', next = '/landed', suffix = '') =>
  `/hop/${status}?to=${to}&next=${encodeURIComponent(next)}${suffix ? `&suffix=${encodeURIComponent(suffix)}` : ''}`;

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
        expect(
          failures.some(
            (failure) =>
              failure.blocked === true && failure.redirect && failure.scope === 'SCOPE_HOST_DENIED'
          )
        ).toBe(true);
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

  it.each([
    ['a fragment', '#frag'],
    ['an empty fragment', '#'],
    ['a re-encoded character', '|x'],
  ])(
    'a hop whose URL Chromium rewrites (%s) is still checked',
    async (_label, suffix) => {
      const fixture = await startFixture();
      try {
        await withPage(scoped(), async (page) => {
          // In-scope 307 whose Location carries the suffix, then 307 out of scope.
          await submit(page, fixture, hopTo(307, 'in', hopTo(307, 'out'), suffix));
          expect(fixture.hits.filter((hit) => hit.path === '/hop/307').length).toBe(2);
          expect(fixture.leaked()).toEqual([]);
        });
      } finally {
        await closeFixture(fixture);
      }
    },
    60_000
  );

  it('two chains converging on the same hop URL are each checked', async () => {
    const fixture = await startFixture();
    try {
      await withPage(scoped(), async (page) => {
        await page.navigate({ url: fixture.url('/two-chains') }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        // Chains are told apart by network id, so neither can consume the
        // other's hop; whichever reach /shared, nothing leaves scope.
        expect(fixture.hits.some((hit) => hit.path === '/shared')).toBe(true);
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
        await expect
          .poll(() => fixture.hits.some((hit) => hit.method === 'POST' && hit.path === '/hop/307'))
          .toBe(true);
        expect(fixture.leaked()).toEqual([]);
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('a scoped document refuses the dedicated worker before it can POST or redirect', async () => {
    const fixture = await startFixture();
    try {
      await withPage(scoped(), async (page) => {
        await page.navigate({
          url: fixture.url(`/worker-page?action=${encodeURIComponent(hopTo(307, 'out'))}`),
        });
        // The browser-enforced scoped worker floor blocks creation, so neither
        // the worker bootstrap nor its native POST is sent.
        expect(
          fixture.hits.some((hit) => hit.path === '/worker.js' || hit.path === '/hop/307')
        ).toBe(false);
        expect(fixture.leaked()).toEqual([]);
      });
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('a redirect loop is blocked as a loop, before the hop cap', async () => {
    const fixture = await startFixture();
    try {
      await withPage(scoped(), async (page, failures) => {
        await submit(page, fixture, '/loop/a');
        expect(fixture.hits.filter((hit) => hit.path.startsWith('/loop/')).length).toBe(2);
        expect(failures.some((failure) => failure.detail === 'REDIRECT_LOOP')).toBe(true);
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
  type Handler = (value: never) => void;
  const emitter = () => {
    const handlers = new Map<string, Handler[]>();
    return {
      on: (event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      emit: (event: string, value: unknown) => {
        for (const handler of handlers.get(event) ?? []) handler(value as never);
      },
    };
  };
  const fakeCdp = () => {
    const events = emitter();
    const sent: Array<{ method: string; params: unknown }> = [];
    return {
      ...events,
      sent,
      send: async (method: string, params?: unknown) => {
        sent.push({ method, params });
        return {};
      },
    };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** A page target and an out-of-process child frame target, both guarded. */
  async function harness(maxChains?: number, overrides: Partial<BodyRedirectGuardOptions> = {}) {
    const pageCdp = fakeCdp();
    const frameCdp = fakeCdp();
    const pageEvents = emitter();
    const page = { on: pageEvents.on };
    const main = { parentFrame: () => null, page: () => page };
    const child = { parentFrame: () => main, page: () => page };
    const context = {
      ...emitter(),
      pages: () => [page],
      newCDPSession: async (owner: unknown) => (owner === page ? pageCdp : frameCdp),
    };
    const guard = new BodyRedirectGuard(context as never, {
      verdictOf: async () => ({ verdict: 'allow' }),
      onBlocked: () => {},
      maxHops: 10,
      ...(maxChains !== undefined ? { maxChains } : {}),
      ...overrides,
    });
    await settle();
    pageEvents.emit('frameattached', child);
    await settle();
    await settle();
    const request = (frame: unknown, url = 'http://127.0.0.1/form') => ({
      frame: () => frame,
      method: () => 'POST',
      url: () => url,
      headers: () => ({}),
    });
    const seen = (
      cdp: ReturnType<typeof fakeCdp>,
      networkId: string,
      url = 'http://127.0.0.1/form'
    ) =>
      cdp.emit('Fetch.requestPaused', {
        requestId: `job-${networkId}`,
        networkId,
        request: { url, method: 'POST', headers: {} },
      });
    return { guard, pageCdp, frameCdp, main, child, request, seen };
  }

  it('fails closed if a per-hop header transform cannot be applied', async () => {
    const outcomes: unknown[] = [];
    const { guard, pageCdp, main, request, seen } = await harness(undefined, {
      headersForRequest: () => {
        throw new Error('private marker');
      },
      onOutcome: (record) => {
        outcomes.push(record);
      },
    });
    seen(pageCdp, 'headers');
    await settle();
    expect(pageCdp.sent.some((call) => call.method === 'Fetch.failRequest')).toBe(true);
    expect(pageCdp.sent.some((call) => call.method === 'Fetch.continueRequest')).toBe(false);
    expect(guard.track(request(main) as never)).toBe(false);
    expect(outcomes).toEqual([
      expect.objectContaining({
        type: 'request.failed',
        data: expect.objectContaining({ detail: 'REQUEST_HEADERS_UNCHECKABLE' }),
      }),
    ]);
    expect(JSON.stringify(outcomes)).not.toContain('private marker');
  });

  it('does not inject research markers into browser-generated preflights', async () => {
    let transformed = 0;
    const { pageCdp } = await harness(undefined, {
      headersForRequest: (_url, headers) => {
        transformed++;
        return { ...headers, 'x-research': 'private-marker' };
      },
    });
    pageCdp.emit('Fetch.requestPaused', {
      requestId: 'preflight',
      networkId: 'preflight-network',
      resourceType: 'Preflight',
      request: {
        url: 'http://localhost/probe',
        method: 'OPTIONS',
        headers: { Origin: 'http://127.0.0.1', 'Access-Control-Request-Method': 'PUT' },
      },
    });
    await settle();
    expect(transformed).toBe(0);
    expect(pageCdp.sent.find((call) => call.method === 'Fetch.continueRequest')?.params).toEqual({
      requestId: 'preflight',
    });
  });

  it('continues a hop with NO header overrides when the policy has no interaction with it', async () => {
    const { guard, pageCdp, main, request, seen } = await harness(undefined, {
      // A destination outside every hostSuffix carrying no marker: undefined.
      headersForRequest: () => undefined,
    });
    seen(pageCdp, 'passthrough');
    await settle();
    const continued = pageCdp.sent.filter((call) => call.method === 'Fetch.continueRequest');
    expect(continued).toHaveLength(1);
    // No headers override at all: the request continues exactly as a scope
    // without requestHeaders would (cross-origin dependencies are untouched).
    expect((continued[0]!.params as { headers?: unknown }).headers).toBeUndefined();
    expect(pageCdp.sent.some((call) => call.method === 'Fetch.failRequest')).toBe(false);
    expect(guard.track(request(main) as never)).toBe(true);
  });

  it('sends CDP header overrides only where the policy returns them, and labels failures accordingly', async () => {
    const outcomes: Array<{ type: string; data: Record<string, unknown> }> = [];
    const { pageCdp, seen } = await harness(undefined, {
      blockDocumentWorkers: true,
      headersForRequest: (_url: string, headers: Record<string, string>) => ({
        ...headers,
        'x-hackerone-research': 'researcher',
      }),
      onOutcome: (record) => {
        outcomes.push(record as { type: string; data: Record<string, unknown> });
      },
    });
    seen(pageCdp, 'override');
    await settle();
    const continued = pageCdp.sent.filter((call) => call.method === 'Fetch.continueRequest');
    expect(continued).toHaveLength(1);
    expect(
      (continued[0]!.params as { headers?: Array<{ name: string; value: string }> }).headers
    ).toContainEqual({ name: 'x-hackerone-research', value: 'researcher' });
    // The response stage of an overridden chain that cannot be re-committed
    // stays a header-policy failure (fail closed, correctly labeled).
    const forward = pageCdp.send.bind(pageCdp);
    pageCdp.send = async (method: string, params?: unknown) => {
      if (method === 'Fetch.takeResponseBodyAsStream') return { stream: 'body' };
      if (method === 'IO.read') return { data: '', eof: true };
      if (method === 'Fetch.fulfillRequest') throw new Error('CDP commit failed');
      return forward(method, params);
    };
    pageCdp.emit('Fetch.requestPaused', {
      requestId: 'job-override',
      networkId: 'override',
      request: { url: 'http://127.0.0.1/form', method: 'POST', headers: {} },
      responseStatusCode: 200,
      responseHeaders: [],
    });
    await settle();
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        type: 'request.failed',
        data: expect.objectContaining({ detail: 'POLICY_HEADERS_UNCHECKABLE' }),
      })
    );
  });

  it('claims a request only after the guard saw it (fail closed)', async () => {
    const { guard, pageCdp, main, request, seen } = await harness();
    expect(guard.track(request(main) as never)).toBe(false);
    seen(pageCdp, 'n1');
    expect(guard.track(request(main) as never)).toBe(true);
    // One sighting claims one request.
    expect(guard.track(request(main) as never)).toBe(false);
  });

  it("claims only from the request's own target, never a sibling target", async () => {
    const { guard, pageCdp, frameCdp, child, request, seen } = await harness();
    // Seen by the page target only: the out-of-process frame's own guard did not see it.
    seen(pageCdp, 'stale');
    expect(guard.track(request(child) as never)).toBe(false);
    seen(frameCdp, 'n2');
    expect(guard.track(request(child) as never)).toBe(true);
  });

  it('fails closed when full: refuses new chains, never evicts a live one', async () => {
    const { guard, pageCdp, main, request, seen } = await harness(2);
    seen(pageCdp, 'a', 'http://127.0.0.1/a');
    seen(pageCdp, 'b', 'http://127.0.0.1/b');
    seen(pageCdp, 'c', 'http://127.0.0.1/c');
    await settle();
    // The third is failed at the guard's request stage and is not claimable.
    expect(pageCdp.sent.some((call) => call.method === 'Fetch.failRequest')).toBe(true);
    expect(guard.track(request(main, 'http://127.0.0.1/c') as never)).toBe(false);
    // The live chains are still tracked.
    expect(guard.track(request(main, 'http://127.0.0.1/a') as never)).toBe(true);
    // A request that ended frees its slot.
    pageCdp.emit('Network.loadingFailed', { requestId: 'b' });
    seen(pageCdp, 'd', 'http://127.0.0.1/d');
    await settle();
    expect(guard.track(request(main, 'http://127.0.0.1/d') as never)).toBe(true);
  });

  it('refuses requests without a frame', async () => {
    const { guard } = await harness();
    const workerRequest = {
      frame: () => {
        throw new Error('no frame');
      },
      method: () => 'POST',
      url: () => 'http://127.0.0.1/form',
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
