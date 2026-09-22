import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

/**
 * The CDP connect path (the spec's RemoteCdpEngine shape): the engine
 * attaches to an already-running Chromium over a loopback DevTools endpoint
 * instead of launching its own, reports the remote name, and reuses that one
 * connection for every session it creates.
 */
describe('remote CDP engine', () => {
  it('connects over a loopback CDP endpoint and reuses the connection across sessions', async () => {
    const { chromium } = await import('playwright');
    const net = await import('node:net');

    // Reserve an ephemeral port, then hand it to Chromium's DevTools server.
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const chosen = (probe.address() as { port: number }).port;
        probe.close(() => resolve(chosen));
      });
    });

    const host = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${port}`],
    });
    try {
      // Chromium serves the browser-wide endpoint descriptor at /json/version.
      let wsEndpoint: string | undefined;
      for (let attempt = 0; attempt < 50 && wsEndpoint === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`);
          wsEndpoint = ((await response.json()) as { webSocketDebuggerUrl?: string })
            .webSocketDebuggerUrl;
        } catch {
          // DevTools server not up yet; keep polling.
        }
      }
      expect(wsEndpoint).toBeDefined();

      const engine = new PlaywrightChromiumEngine({ cdpEndpoint: wsEndpoint });
      try {
        expect(engine.name).toBe('playwright-chromium-remote');

        const first = await engine.createSession({ headless: true });
        const page = await first.newPage();
        await page.navigate({ url: 'data:text/html,<title>Remote</title><button>Go</button>' });
        const state = await page.observe({});
        expect(state.elements.some((el) => el.role === 'button' && el.name === 'Go')).toBe(true);

        // A second session attaches over the same connection: no reconnect,
        // and its page set is independent of the first session's.
        const second = await engine.createSession({ headless: true });
        expect(await second.pages()).toHaveLength(0);
        expect((await first.pages()).map((p) => p.id)).toEqual([page.id]);

        await second.close();
        await first.close();
      } finally {
        await engine.close();
      }
    } finally {
      // Depending on Playwright semantics the connected browser may already
      // have been disconnected by engine.close(); never let that fail cleanup.
      await host.close().catch(() => {});
    }
  }, 30_000);
});
