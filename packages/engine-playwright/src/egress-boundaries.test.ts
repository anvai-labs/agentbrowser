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
      request: () => ({ url: () => 'https://example.test/' }),
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
