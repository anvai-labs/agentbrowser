import { describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

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
      {}
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
      {}
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
