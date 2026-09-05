/**
 * TD-BROWSER-8 Phase 2, pressure matrix row 2: waitForLabel against real
 * Chromium (not FakeEngine). The FakeEngine coverage in service.test.ts
 * proves the poll loop's mechanics; this proves it against a real browser
 * asynchronously mutating its own DOM in response to a click - the actual
 * scenario the feature exists for.
 *
 * The service's navigate() only accepts http(s) URLs (no data:), so this
 * serves the fixture from a real loopback HTTP server; the shared default
 * NetworkPolicy blocks loopback (SSRF hardening), so this test injects its
 * own permissive policy instance rather than weakening the default.
 */

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentBrowserService } from './service';

describe('waitForLabel against real Chromium (pressure matrix row 2)', () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeEach(async () => {
    httpServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<!DOCTYPE html><html><body>' +
          '<button id="c" onclick="setTimeout(function(){' +
          "document.getElementById('pwd').removeAttribute('hidden');" +
          '},150)">Continue</button>' +
          '<input id="pwd" aria-label="Password" type="password" hidden />' +
          '</body></html>'
      );
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('waits for a click-revealed password field, then fills it', async () => {
    const engine = new PlaywrightChromiumEngine();
    const service = new AgentBrowserService({
      engine,
      networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
    });
    try {
      const session = await service.createSession({ tenantId: 't1' });
      const page = await service.createPage(session.sessionId);
      await service.navigate(session.sessionId, page.pageId, { url: baseUrl });

      const obs = (await service.observe(session.sessionId, page.pageId, {
        mode: 'interactive',
      })) as unknown as { elements: Array<{ ref: string; name?: string }> };
      const continueRef = obs.elements.find((e) => e.name === 'Continue')?.ref;
      expect(continueRef).toBeDefined();

      const result = await service.executePlan(session.sessionId, page.pageId, [
        { action: 'click', target: { ref: continueRef } },
        { action: 'fill', waitForLabel: 'Password', value: 'hunter2' } as never,
      ]);

      expect(result.ok).toBe(true);
      expect(result.results).toHaveLength(2);

      const after = (await service.observe(session.sessionId, page.pageId, {
        mode: 'interactive',
      })) as unknown as { elements: Array<{ name?: string; value?: string }> };
      const password = after.elements.find((e) => e.name === 'Password');
      expect(password?.value).toBe('hunter2');
    } finally {
      await service.shutdown();
    }
  }, 30_000);

  it('surfaces a typed timeout when the labeled field never appears', async () => {
    const engine = new PlaywrightChromiumEngine();
    const service = new AgentBrowserService({
      engine,
      networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
    });
    try {
      const session = await service.createSession({ tenantId: 't1' });
      const page = await service.createPage(session.sessionId);
      await service.navigate(session.sessionId, page.pageId, { url: baseUrl });

      const result = await service.executePlan(session.sessionId, page.pageId, [
        { action: 'click', waitForLabel: 'Never Appears', waitMs: 300 } as never,
      ]);

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('PLAN_WAIT_TIMEOUT');
    } finally {
      await service.shutdown();
    }
  }, 30_000);
});
