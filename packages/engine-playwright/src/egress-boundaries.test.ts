import { describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine, type RequestEventSink } from './index.js';

const sink = (): RequestEventSink => ({ emit: undefined, navigationFailures: new WeakMap() });
const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: dnsLookup }));

describe('egress revalidation', () => {
  it('does not cache an allow across a DNS address change and disposes fetched bodies', async () => {
    dnsLookup
      .mockResolvedValueOnce([{ address: '1.1.1.1' }])
      .mockResolvedValueOnce([{ address: '127.0.0.1' }]);
    let routeHandler: ((route: unknown) => Promise<void>) | undefined;
    const engine = new PlaywrightChromiumEngine();
    await (
      engine as unknown as {
        installEgress(context: unknown, policy: unknown, sink: unknown): Promise<void>;
      }
    ).installEgress(
      {
        route: async (_pattern: string, handler: typeof routeHandler) => {
          routeHandler = handler;
        },
      },
      {
        checkRequest: async () => {},
        checkResolvedAddresses: async (addresses: string[]) => {
          if (addresses.includes('127.0.0.1')) throw new Error('denied');
        },
        checkBodySize: async () => {},
      },
      sink()
    );
    const dispose = vi.fn(async () => {});
    const response = {
      headers: () => ({}),
      body: async () => Buffer.from('<p>visible</p>'),
      status: () => 200,
      dispose,
    };
    const fetch = vi.fn(async () => response);
    const fulfill = vi.fn(async () => {});
    const route = {
      request: () => ({ url: () => 'https://example.test/', method: () => 'GET' }),
      fetch,
      fulfill,
      abort: vi.fn(),
    };
    if (!routeHandler) throw new Error('Missing route handler');
    await routeHandler(route);
    expect(fulfill.mock.calls[0]?.[0]).toMatchObject({ body: Buffer.from('<p>visible</p>') });
    expect(dispose).toHaveBeenCalledOnce();
    await routeHandler(route);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fulfill.mock.calls[1]?.[0]).toMatchObject({ status: 403 });
    expect(dnsLookup).toHaveBeenCalledTimes(2);
    dnsLookup.mockResolvedValue([{ address: '1.1.1.1' }]);
    dispose.mockRejectedValueOnce(new Error('context closed during disposal'));
    await expect(routeHandler(route)).resolves.toBeUndefined();
    expect(route.abort).not.toHaveBeenCalled();
    fulfill.mockRejectedValueOnce(new Error('context closed during fulfill'));
    await expect(routeHandler(route)).resolves.toBeUndefined();
    expect(route.abort).not.toHaveBeenCalled();
  });
});

describe('egress body-bearing request passthrough', () => {
  async function installHandler(policy: {
    checkRequest: () => Promise<void>;
  }): Promise<(route: unknown) => Promise<void>> {
    let routeHandler: ((route: unknown) => Promise<void>) | undefined;
    const engine = new PlaywrightChromiumEngine();
    await (
      engine as unknown as {
        installEgress(context: unknown, policy: unknown, sink: unknown): Promise<void>;
      }
    ).installEgress(
      {
        route: async (_pattern: string, handler: typeof routeHandler) => {
          routeHandler = handler;
        },
      },
      policy,
      sink()
    );
    if (!routeHandler) throw new Error('Missing route handler');
    return routeHandler;
  }

  it.each(['POST', 'PUT', 'PATCH'])(
    'continues an allowed %s request natively instead of replaying it through fetch/fulfill',
    async (method) => {
      const routeHandler = await installHandler({ checkRequest: async () => {} });
      const fetch = vi.fn();
      const fulfill = vi.fn();
      const continueFn = vi.fn(async () => {});
      const route = {
        request: () => ({ url: () => 'https://s3.example.test/bucket', method: () => method }),
        fetch,
        fulfill,
        continue: continueFn,
        abort: vi.fn(),
      };
      await routeHandler(route);
      expect(continueFn).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
      expect(fulfill).not.toHaveBeenCalled();
    }
  );

  it('still blocks a denied POST request rather than continuing it', async () => {
    const routeHandler = await installHandler({
      checkRequest: async () => {
        throw new Error('denied');
      },
    });
    const fetch = vi.fn();
    const fulfill = vi.fn(async () => {});
    const continueFn = vi.fn();
    const route = {
      request: () => ({ url: () => 'https://internal.example.test/', method: () => 'POST' }),
      fetch,
      fulfill,
      continue: continueFn,
      abort: vi.fn(),
    };
    await routeHandler(route);
    expect(continueFn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(fulfill.mock.calls[0]?.[0]).toMatchObject({ status: 403 });
  });

  it('leaves GET requests on the fetch/fulfill inspection path', async () => {
    const routeHandler = await installHandler({ checkRequest: async () => {} });
    const response = {
      headers: () => ({}),
      body: async () => Buffer.from(''),
      status: () => 200,
      dispose: vi.fn(async () => {}),
    };
    const fetch = vi.fn(async () => response);
    const fulfill = vi.fn(async () => {});
    const continueFn = vi.fn();
    const route = {
      request: () => ({ url: () => 'https://example.test/', method: () => 'GET' }),
      fetch,
      fulfill,
      continue: continueFn,
      abort: vi.fn(),
    };
    await routeHandler(route);
    expect(fetch).toHaveBeenCalledOnce();
    expect(continueFn).not.toHaveBeenCalled();
  });
});

describe('egress all-hop redirect enforcement', () => {
  async function installHandler(policy: {
    checkRequest: (input: { url: string }) => Promise<void>;
  }): Promise<(route: unknown) => Promise<void>> {
    let routeHandler: ((route: unknown) => Promise<void>) | undefined;
    const engine = new PlaywrightChromiumEngine();
    await (
      engine as unknown as {
        installEgress(context: unknown, policy: unknown, sink: unknown): Promise<void>;
      }
    ).installEgress(
      {
        route: async (_pattern: string, handler: typeof routeHandler) => {
          routeHandler = handler;
        },
      },
      policy,
      sink()
    );
    if (!routeHandler) throw new Error('Missing route handler');
    return routeHandler;
  }

  const makeResponse = (status: number, location?: string, body = '') => ({
    headers: async () => (location === undefined ? ({} as Record<string, string>) : { location }),
    body: async () => Buffer.from(body),
    status: () => status,
    dispose: vi.fn(async () => {}),
  });

  function chainRoute(urls: string[], byUrl: Map<string, ReturnType<typeof makeResponse>>) {
    const fetched: string[] = [];
    const fulfill = vi.fn(async () => {});
    const route = {
      request: () => ({
        url: () => urls[0],
        method: () => 'GET',
        resourceType: () => 'document',
        frame: () => ({ page: () => undefined }),
      }),
      fetch: vi.fn(async (options?: { url?: string }) => {
        const target = options?.url ?? urls[0];
        fetched.push(target);
        const response = byUrl.get(target);
        if (!response) throw new Error(`unexpected fetch ${target}`);
        return response;
      }),
      fulfill,
      abort: vi.fn(),
    };
    return { route, fetched, fulfill };
  }

  it('walks the chain node-side and checks every hop before it is fetched', async () => {
    const checked: string[] = [];
    const routeHandler = await installHandler({
      checkRequest: async ({ url }) => {
        checked.push(url);
        if (url.endsWith('/forbidden')) throw new Error('POLICY_DENIED: forbidden');
      },
    });
    const byUrl = new Map([
      ['https://example.test/start', makeResponse(302, '/hop')],
      ['https://example.test/hop', makeResponse(302, '/forbidden')],
      ['https://example.test/forbidden', makeResponse(200, undefined, '<p>no</p>')],
    ]);
    const { route, fetched, fulfill } = chainRoute(['https://example.test/start'], byUrl);
    await routeHandler(route);
    // The forbidden terminal is refused before it is ever fetched.
    expect(fetched).toEqual(['https://example.test/start', 'https://example.test/hop']);
    expect(checked.some((url) => url.endsWith('/forbidden'))).toBe(true);
    expect(fulfill.mock.calls[0]?.[0]).toMatchObject({ status: 403 });
    // Every intermediate redirect response is disposed.
    for (const [url, response] of byUrl) {
      if (url === 'https://example.test/forbidden') continue;
      expect(response.dispose).toHaveBeenCalledOnce();
    }
  });

  it('redirects the browser to a verified terminal so the document URL is right', async () => {
    const routeHandler = await installHandler({
      checkRequest: async () => {},
      checkBodySize: async () => {},
    } as never);
    const terminal = makeResponse(200, undefined, '<p>arrived</p>');
    const byUrl = new Map([
      ['https://example.test/a', makeResponse(302, '/b')],
      ['https://example.test/b', terminal],
    ]);
    const { route, fetched, fulfill } = chainRoute(['https://example.test/a'], byUrl);
    await routeHandler(route);
    expect(fetched).toEqual(['https://example.test/a', 'https://example.test/b']);
    // The original request is fulfilled with a redirect to the verified
    // terminal URL; the document lands at the right address, and the
    // browser's own fetch of it is not served from our (now disposed)
    // verification copy.
    expect(fulfill.mock.calls[0]?.[0]).toMatchObject({
      status: 302,
      headers: { location: 'https://example.test/b' },
    });
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(byUrl.get('https://example.test/a')?.dispose).toHaveBeenCalledOnce();
  });

  it('fulfills a single-response request byte-exactly with no redirect phase', async () => {
    const routeHandler = await installHandler({
      checkRequest: async () => {},
      checkBodySize: async () => {},
    } as never);
    const terminal = makeResponse(200, undefined, '<p>direct</p>');
    const byUrl = new Map([['https://example.test/', terminal]]);
    const { route, fulfill } = chainRoute(['https://example.test/'], byUrl);
    await routeHandler(route);
    expect(fulfill.mock.calls[0]?.[0]).toMatchObject({
      response: terminal,
      body: Buffer.from('<p>direct</p>'),
    });
  });

  it('refuses a redirect loop', async () => {
    const routeHandler = await installHandler({ checkRequest: async () => {} });
    const byUrl = new Map([['https://example.test/loop', makeResponse(302, '/loop')]]);
    const { route, fetched, fulfill } = chainRoute(['https://example.test/loop'], byUrl);
    await routeHandler(route);
    expect(fetched).toEqual(['https://example.test/loop']);
    expect(fulfill.mock.calls[0]?.[0]).toMatchObject({ status: 403 });
  });

  it('emits bounded vocabulary reasons and query-free redirect locations', async () => {
    const emitted: Array<Record<string, unknown>> = [];
    let routeHandler: ((route: unknown) => Promise<void>) | undefined;
    const engine = new PlaywrightChromiumEngine();
    await (
      engine as unknown as {
        installEgress(context: unknown, policy: unknown, sink: unknown): Promise<void>;
      }
    ).installEgress(
      {
        route: async (_pattern: string, handler: typeof routeHandler) => {
          routeHandler = handler;
        },
      },
      { checkRequest: async () => {}, checkBodySize: async () => {} },
      {
        emit: (event: { data: Record<string, unknown> }) => {
          emitted.push(event.data);
        },
        navigationFailures: new WeakMap(),
      }
    );
    if (!routeHandler) throw new Error('Missing route handler');
    const terminal = makeResponse(200, undefined, '<p>end</p>');
    const byUrl = new Map<string, ReturnType<typeof makeResponse>>([
      ['https://example.test/h0?entry=1', makeResponse(302, '/h1?token=secret-query')],
      ['https://example.test/h1?token=secret-query', makeResponse(302, '/h2')],
      // h2 sends the chain back to the already-visited h1: the loop fires.
      ['https://example.test/h2', makeResponse(302, '/h1?token=secret-query')],
    ]);
    const { route } = chainRoute(['https://example.test/h0?entry=1'], byUrl);
    await routeHandler(route);
    const failed = emitted.filter((entry) => entry.blocked === true);
    // Every denial carries the bounded vocabulary reason, never free-form codes.
    for (const entry of failed) expect(entry.reason).toBe('egress_policy');
    // The loop-detection location is query-stripped even though the hop URL
    // carried a query string.
    const looped = emitted.find((entry) => entry.detail === 'REDIRECT_LOOP');
    expect(looped).toBeDefined();
    expect(String(looped?.redirect)).not.toContain('?');
  });

  it('caps redirect chain length', async () => {
    const routeHandler = await installHandler({ checkRequest: async () => {} });
    const byUrl = new Map<string, ReturnType<typeof makeResponse>>();
    for (let index = 0; index < 20; index += 1) {
      byUrl.set(`https://example.test/h${index}`, makeResponse(302, `/h${index + 1}`));
    }
    byUrl.set('https://example.test/h20', makeResponse(200, undefined, 'end'));
    const { route, fetched, fulfill } = chainRoute(['https://example.test/h0'], byUrl);
    await routeHandler(route);
    expect(fetched.length).toBeLessThanOrEqual(12);
    expect(fulfill.mock.calls[0]?.[0]).toMatchObject({ status: 403 });
  });
});
