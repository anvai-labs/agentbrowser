import * as dns from 'node:dns/promises';
import http from 'node:http';
import { EngineError } from '@agentbrowser/engine';
import { afterEach, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

vi.mock('node:dns/promises', async (original) => {
  const actual = await original<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});
afterEach(() => vi.restoreAllMocks());

it.each([
  ['ENOTFOUND', 'dns_unresolved'],
  ['ETIMEDOUT', 'dns_timeout'],
  ['EREFUSED', 'dns_refused'],
  ['EMFILE', 'engine_error'],
])(
  'preserves resolver failure %s at the route owner without leaking topology',
  async (code, reason) => {
    vi.mocked(dns.lookup).mockRejectedValueOnce(
      Object.assign(new Error('private-secret-host 10.0.0.1'), { code })
    );
    const addresses = vi.fn();
    const engine = new PlaywrightChromiumEngine({
      egress: { async checkRequest() {}, checkResolvedAddresses: addresses },
    });
    try {
      const session = await engine.createSession();
      const page = await session.newPage();
      const result = await page.navigate({ url: 'http://unresolved.example/' });
      expect(result).toMatchObject({ status: 'blocked', reason });
      expect(JSON.stringify(result)).not.toMatch(/private-secret|10\.0\.0\.1/);
      expect(addresses).not.toHaveBeenCalled();
    } finally {
      await engine.close();
    }
  }
);

it('binds policy denial to the routed request and ignores remote spoofed diagnostic headers', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(502, { 'x-agentbrowser-blocked': '1', 'x-agentbrowser-reason': 'dns_nxdomain' });
    res.end('<button>real content</button>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const checkRequest = vi.fn(async () => {});
  const engine = new PlaywrightChromiumEngine({ egress: { checkRequest } });
  try {
    const session = await engine.createSession();
    const page = await session.newPage();
    checkRequest.mockRejectedValueOnce(new EngineError('POLICY_DENIED', 'private policy details'));
    expect(await page.navigate({ url })).toMatchObject({
      status: 'blocked',
      reason: 'egress_policy',
    });
    const next = await page.navigate({ url });
    expect(next.status).toBe('success');
    expect(next).not.toHaveProperty('reason');
  } finally {
    await engine.close();
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
});

it.each([
  ['net::ERR_DNS_TIMED_OUT', 'dns_timeout'],
  ['net::ERR_CERT_AUTHORITY_INVALID', 'tls_refused'],
  ['net::ERR_CONNECTION_REFUSED', 'connection_refused'],
  ['net::ERR_FAILED', 'engine_error'],
])('classifies native goto failure %s without leaking its URL', async (code, reason) => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const page = await (await engine.createSession()).newPage();
    const native = (page as unknown as { backingPage(): import('playwright').Page }).backingPage();
    vi.spyOn(native, 'goto').mockRejectedValue(
      new Error(`page.goto: ${code} at https://secret-host/?private-token`)
    );
    const failure = await page.navigate({ url: 'https://example.com/' }).catch((error) => error);
    expect(failure.details).toEqual({ reason });
    expect(failure.message).not.toMatch(/secret-host|private-token/);
  } finally {
    await engine.close();
  }
});

it('a committed routed transport failure invalidates refs and cannot leak its destination in events', async () => {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const engine = new PlaywrightChromiumEngine({ egress: { async checkRequest() {} } });
  const events: import('@agentbrowser/engine').EngineEvent[] = [];
  try {
    const page = await (await engine.createSession()).newPage();
    void (async () => {
      for await (const event of page.events()) events.push(event);
    })();
    await page.navigate({ url: 'data:text/html,<button>old</button>' });
    const before = await page.observe({});
    const error = await page
      .navigate({ url: `http://127.0.0.1:${port}/private-path?token=private-token` })
      .catch((error) => error);
    expect(error.details).toEqual({ reason: 'connection_refused' });
    const after = await page.observe({});
    expect(after.revision).toBeGreaterThan(before.revision ?? 0);
    expect(after.elements.some((element) => element.name === 'old')).toBe(false);
    const failure = events.find((event) => event.type === 'request.failed');
    expect(failure?.data?.reason).toBe('connection_refused');
    expect(JSON.stringify(error)).not.toMatch(/127\.0\.0\.1|private-path|private-token/);
    expect(String(failure?.data?.reason)).not.toMatch(/127\.0\.0\.1|private-path|private-token/);
  } finally {
    await engine.close();
  }
});

it('a child document failure cannot overwrite a successful main document reason', async () => {
  const server = http.createServer((_req, res) =>
    res.end(
      '<html><button>Main</button><iframe src="http://child-unresolved.example/"></iframe></html>'
    )
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vi.mocked(dns.lookup).mockRejectedValueOnce(
    Object.assign(new Error('private child'), { code: 'ETIMEDOUT' })
  );
  const engine = new PlaywrightChromiumEngine({
    egress: { async checkRequest() {}, async checkResolvedAddresses() {} },
  });
  try {
    const page = await (await engine.createSession()).newPage();
    const result = await page.navigate({
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    });
    expect(result.status).toBe('success');
    expect(result).not.toHaveProperty('reason');
  } finally {
    await engine.close();
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
});
