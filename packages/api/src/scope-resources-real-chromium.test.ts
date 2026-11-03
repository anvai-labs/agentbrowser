// P1-5 (ADR-028 resource class): the functional-dependency lane end to end —
// page-initiated GET fetch to a resource-class host is admitted without
// markers or credentials, while navigations and disallowed methods refuse.
//
// The resource POST lane rides the engine's inspected-lane workaround for
// the Chromium continue bug on cross-origin bodies (see the engine's route
// handler); policy-layer admission lives in scope-assets.test.ts.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';

interface Hit {
  host: string;
  path: string;
  method: string;
  body: string;
  marker?: string;
  cookie?: string;
}

it('resource-class hosts admit page-initiated GET fetches and refuse navigations and mutations', async () => {
  const hits: Hit[] = [];
  let port = 0;
  const fixture = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const host = req.headers.host?.split(':')[0] ?? '';
      hits.push({
        host,
        path: req.url ?? '/',
        method: req.method ?? 'GET',
        body: Buffer.concat(chunks).toString(),
        marker: req.headers['x-research'] as string | undefined,
        cookie: req.headers.cookie,
      });
      if (host === 'localhost') {
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        `<body><h1>program</h1><script>
fetch('http://localhost:${port}/ping').catch(() => {});
fetch('http://localhost:${port}/beacon', {method: 'POST', body: '{"t":1}', headers: {'content-type': 'text/plain'}}).catch(() => {});
fetch('http://localhost:${port}/mutate', {method: 'PUT', body: '{}'}).catch(() => {});
</script></body>`
      );
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, resolve));
  port = (fixture.address() as AddressInfo).port;
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
  });
  try {
    const session = await service.createSession({
      tenantId: 'fixture',
      scope: {
        allowedHosts: ['127.0.0.1'],
        // The program method list is deliberately read-only: the resource
        // class carries its own method set (P1-5).
        allowedMethods: ['GET'],
        assetHosts: [{ host: 'localhost', class: 'resource', category: 'captcha' }],
        requestHeaders: [{ header: 'x-research', value: 'research-marker' }],
      },
    });
    const { pageId } = await service.createPage(session.sessionId);
    await service.navigate(session.sessionId, pageId, { url: `http://127.0.0.1:${port}/` });

    // The GET fetch and the POST beacon both land on the resource host —
    // no marker, no credential (the same hygiene as the asset class).
    await expect.poll(() => hits.filter((h) => h.host === 'localhost').length).toBe(2);
    const beacon = hits.find((h) => h.path === '/beacon');
    expect(beacon).toMatchObject({ method: 'POST', body: '{"t":1}' });
    const ping = hits.find((h) => h.path === '/ping');
    expect(ping).toMatchObject({ method: 'GET' });
    expect(ping?.marker).toBeUndefined();
    // No credential rides along: at most the transform's explicit EMPTY
    // cookie (the jar-reattachment guard), never a value.
    expect(ping?.cookie === undefined || ping?.cookie === '').toBe(true);

    // PUT never reaches the resource host: the refusal is in the denial summary.
    await expect
      .poll(() =>
        service
          .getScopeDenied(session.sessionId)
          .hosts.some((h) => h.hostname === 'localhost' && h.count >= 1)
      )
      .toBe(true);
    expect(hits.some((h) => h.path === '/mutate')).toBe(false);

    // A resource host is never a navigation destination.
    await expect(
      service.navigate(session.sessionId, pageId, { url: `http://localhost:${port}/` })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  } finally {
    await service.shutdown();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}, 60000);
