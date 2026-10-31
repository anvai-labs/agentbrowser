import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';

it('loads static assets without program markers/credentials, rechecks redirects and refuses active lanes', async () => {
  const received: Array<{
    host: string;
    path: string;
    marker?: string;
    cookie?: string;
    auth?: string;
  }> = [];
  let port = 0;
  const fixture = createServer((req, res) => {
    const host = req.headers.host?.split(':')[0] ?? '';
    const path = req.url ?? '/';
    received.push({
      host,
      path,
      marker: req.headers['x-research'] as string | undefined,
      cookie: req.headers.cookie,
      auth: req.headers.authorization,
    });
    if (path === '/') {
      res.setHeader('content-type', 'text/html');
      res.setHeader('set-cookie', 'program=private-program-cookie; Path=/');
      res.end(`<body><h1>program</h1><script src="http://127.0.0.1:${port}/first.js"></script>
        <script src="http://127.0.0.1:${port}/return.js"></script>
        <script src="/to-asset.js"></script><script src="/userinfo.js"></script>
        <iframe src="http://127.0.0.1:${port}/frame"></iframe>
        <script>fetch('http://127.0.0.1:${port}/fetch').catch(()=>{});</script></body>`);
    } else if (path === '/userinfo.js') {
      res.writeHead(302, {
        location: `http://asset-user:asset-password@127.0.0.1:${port}/credential.js`,
      });
      res.end();
    } else if (path === '/to-asset.js') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/second.js` });
      res.end();
    } else if (path === '/return.js') {
      res.writeHead(302, { location: `http://localhost:${port}/program.js` });
      res.end();
    } else {
      res.setHeader('content-type', 'application/javascript');
      res.setHeader('set-cookie', 'asset=private-asset-cookie; Path=/');
      res.end('document.body.append(" static-ready ");');
    }
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
        allowedHosts: ['localhost'],
        assetHosts: [{ host: '127.0.0.1', class: 'asset' }],
        requestHeaders: [{ header: 'x-research', value: 'research-marker' }],
      },
    });
    const { pageId } = await service.createPage(session.sessionId);
    await service.navigate(session.sessionId, pageId, { url: `http://localhost:${port}/` });
    await expect.poll(() => received.filter((r) => r.host === '127.0.0.1').length).toBe(3);
    const assets = received.filter((r) => r.host === '127.0.0.1');
    expect(assets.map((r) => r.path).sort()).toEqual(['/first.js', '/return.js', '/second.js']);
    expect(assets.every((r) => !r.marker && !r.cookie && !r.auth)).toBe(true);
    expect(received.find((r) => r.path === '/program.js')).toMatchObject({
      marker: 'research-marker',
    });
    await expect
      .poll(() =>
        service
          .getScopeDenied(session.sessionId)
          .hosts.some((h) => h.hostname === '127.0.0.1' && h.count >= 2)
      )
      .toBe(true);
    await expect(
      service.navigate(session.sessionId, pageId, { url: `http://127.0.0.1:${port}/frame` })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  } finally {
    await service.shutdown();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}, 60000);
