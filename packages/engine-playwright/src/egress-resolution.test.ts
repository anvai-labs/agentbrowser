import http from 'node:http';
import type { EngineEvent } from '@agentbrowser/engine';
import { describe, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

/**
 * Fixture server: `/` is a small page, `/slow-image` records its arrival and
 * completes its response only after a fixed delay so requests can be held
 * in-flight across page closes.
 */
async function fixtureServer(): Promise<{
  port: number;
  origin: string;
  requestArrived(path: string): boolean;
  requestServed(path: string): boolean;
  stop(): Promise<void>;
}> {
  const arrived = new Set<string>();
  const served = new Set<string>();
  const server = http.createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    arrived.add(path);
    if (path === '/slow-image') {
      const payload = Buffer.alloc(64, 0x78);
      setTimeout(() => {
        served.add(path);
        response.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(payload.length),
        });
        response.end(payload);
      }, 600);
      return;
    }
    served.add(path);
    const body = '<!DOCTYPE html><body>ok</body>';
    response.writeHead(200, {
      'content-type': 'text/html',
      'content-length': String(body.length),
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requestArrived: (path) => arrived.has(path),
    requestServed: (path) => served.has(path),
    stop: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** Collect the page's request.* events for the duration of the test. */
function requestEvents(page: { events(): AsyncIterable<EngineEvent> }): {
  seen: EngineEvent[];
} {
  const seen: EngineEvent[] = [];
  (async () => {
    for await (const event of page.events()) {
      seen.push(event);
    }
  })().catch(() => {});
  return { seen };
}

/**
 * The egress choke point's resolution gates: IP literals skip DNS and go
 * straight to the resolved-address check, unresolvable hostnames are a
 * policy denial (not a transport error), refused connections are transport
 * failures (not policy denials), and lifecycle events for pages that vanished
 * mid-flight must not destabilize the session.
 */
describe('egress resolution gates', () => {
  it('validates an IP-literal request without DNS and hands the literal to the address gate', async () => {
    const fixtures = await fixtureServer();
    const seenAddresses: string[][] = [];
    const engine = new PlaywrightChromiumEngine({
      egress: {
        async checkRequest() {},
        async checkResolvedAddresses(addresses: string[]) {
          seenAddresses.push(addresses);
        },
      },
    });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();

      const result = await page.navigate({ url: `${fixtures.origin}/` });

      expect(result.status).toBe('success');
      // A literal needs no resolution: the exact literal reaches the gate.
      expect(seenAddresses).toContainEqual(['127.0.0.1']);
    } finally {
      await engine.close();
      await fixtures.stop();
    }
  });

  it('blocks a navigation to a hostname that cannot be resolved and cites POLICY_DENIED', async () => {
    const engine = new PlaywrightChromiumEngine({
      egress: {
        async checkRequest() {},
        // Would allow every resolvable address: the block must come from the
        // resolution failure itself, not from an address rejection.
        async checkResolvedAddresses() {},
      },
    });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      const { seen } = await requestEvents(page);

      // A 64-char label is syntactically navigable but guaranteed unresolvable.
      const host = 'x'.repeat(64);
      const result = await page.navigate({ url: `http://${host}/` });

      expect(result.status).toBe('blocked');
      await vi.waitFor(() => {
        expect(seen.some((event) => event.type === 'request.failed')).toBe(true);
      });
      const denied = seen.find((event) => event.type === 'request.failed');
      expect(denied?.data).toMatchObject({
        blocked: true,
        reason: 'dns_unresolved',
        hostname: host,
      });
    } finally {
      await engine.close();
    }
  });

  it('records a refused connection as a transport failure, not a policy denial', async () => {
    // A port with no listener on loopback.
    const deadPort = await new Promise<number>((resolve) => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const chosen = (probe.address() as { port: number }).port;
        probe.close(() => resolve(chosen));
      });
    });
    const engine = new PlaywrightChromiumEngine({
      egress: { async checkRequest() {} },
    });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      const { seen } = await requestEvents(page);

      await expect(page.navigate({ url: `http://127.0.0.1:${deadPort}/` })).rejects.toThrow(
        /Navigation failed: connection_refused/
      );

      await vi.waitFor(() => {
        expect(seen.some((event) => event.type === 'request.failed')).toBe(true);
      });
      const failure = seen.find((event) => event.type === 'request.failed');
      expect(failure?.data).toMatchObject({ blocked: false });
      expect(failure?.data?.hostname).toBe('127.0.0.1');
    } finally {
      await engine.close();
    }
  });

  it('keeps the session healthy when a request event lands after its page closed', async () => {
    const fixtures = await fixtureServer();
    const engine = new PlaywrightChromiumEngine({
      egress: { async checkRequest() {} },
    });
    try {
      const session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      // domcontentloaded returns before the slow image finishes; the page is
      // closed while its request is still in flight.
      await page.navigate({
        url: `data:text/html,<img src="${fixtures.origin}/slow-image">`,
        waitUntil: 'domcontentloaded',
      });
      await vi.waitFor(() => expect(fixtures.requestArrived('/slow-image')).toBe(true));
      await page.close();
      await vi.waitFor(() => expect(fixtures.requestServed('/slow-image')).toBe(true));
      // Let the routed response settle and its lifecycle event arrive for a
      // page this session no longer tracks. The event is dropped; nothing
      // may throw (vitest fails the run on unhandled rejections).
      await new Promise((resolve) => setTimeout(resolve, 300));

      const next = await session.newPage();
      await next.navigate({ url: 'data:text/html,<button>Alive</button>' });
      const state = await next.observe({});
      expect(state.elements.some((el) => el.role === 'button' && el.name === 'Alive')).toBe(true);
      await next.close();
      await session.close();
    } finally {
      await engine.close();
      await fixtures.stop();
    }
  });
});
