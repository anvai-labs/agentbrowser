import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';

it('blocks worker creation before asset grants, including native POST documents, while retaining existing CSP', async () => {
  let port = 0;
  const hits: Array<{ host: string; path: string; method: string }> = [];
  const fixture = createServer((req, res) => {
    const path = req.url ?? '/';
    hits.push({ host: req.headers.host?.split(':')[0] ?? '', path, method: req.method ?? '' });
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'text/html');
      // This restriction must survive our independent worker policy.
      res.setHeader('content-security-policy', "img-src 'none'");
      if (path === '/redirect') {
        res.writeHead(302, { location: '/document' });
        res.end();
      } else if (path === '/post-hop') {
        res.writeHead(307, { location: '/post-document' });
        res.end();
      } else if (path.startsWith('/worker')) {
        res.setHeader('content-type', 'application/javascript');
        res.end(`importScripts('http://127.0.0.1:${port}/worker-asset.js');`);
      } else if (path.startsWith('/blocked')) {
        res.end('recorded');
      } else if (path.startsWith('/start')) {
        res.end(
          `<form method="post" action="${path === '/start' ? '/post-hop' : path.replace('/start-', '/terminal-')}"><input name="x" value="1"></form><script>document.forms[0].submit()</script>`
        );
      } else {
        const phase =
          path === '/post-document'
            ? 'post'
            : path.startsWith('/terminal-')
              ? path.slice(1)
              : 'get';
        if (path.startsWith('/terminal-')) {
          res.statusCode = path.includes('302') ? 302 : 300;
          if (path.endsWith('-location')) res.setHeader('location', '/must-not-follow-300');
        }
        if (phase === 'post') {
          res.setHeader('content-encoding', 'gzip');
          res.setHeader('set-cookie', ['postA=one; Path=/', 'postB=two; Path=/']);
        }
        const html = `<script>
          let blocked = 0;
          addEventListener('securitypolicyviolation', e => {
            if (e.effectiveDirective === 'worker-src') fetch('/blocked-${phase}-' + (++blocked));
          });
          for (const run of [
            () => new Worker('/worker-classic.js'),
            () => new Worker('/worker-module.js', {type:'module'}),
            () => new SharedWorker('/worker-shared.js'),
            () => new Worker(URL.createObjectURL(new Blob(["importScripts('http://127.0.0.1:${port}/worker-asset.js')"], {type:'application/javascript'}))),
          ]) { try {run()} catch {} }
          </script><img src="/image-must-stay-denied">`;
        res.end(phase === 'post' ? gzipSync(html) : html);
      }
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, resolve));
  port = (fixture.address() as { port: number }).port;
  const engine = new PlaywrightChromiumEngine();
  const service = new AgentBrowserService({
    engine,
    networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
  });
  try {
    // No initial assets: worker exclusion must already hold for a later live append.
    const session = await service.createSession({ scope: { allowedHosts: ['localhost'] } });
    const { pageId } = await service.createPage(session.sessionId);
    await service.navigate(session.sessionId, pageId, { url: `http://localhost:${port}/redirect` });
    await expect
      .poll(() => hits.filter((h) => h.path.startsWith('/blocked-get-')).length)
      .toBeGreaterThanOrEqual(4);
    const assets = await service.createSession({
      scope: { allowedHosts: ['localhost'], assetHosts: [{ host: '127.0.0.1', class: 'asset' }] },
    });
    const assetPage = await service.createPage(assets.sessionId);
    await service.navigate(assets.sessionId, assetPage.pageId, {
      url: `http://localhost:${port}/start`,
    });
    await expect
      .poll(() => hits.filter((h) => h.path.startsWith('/blocked-post-')).length, {
        message: JSON.stringify(hits),
      })
      .toBeGreaterThanOrEqual(4);
    for (const terminal of ['300', '302', '300-location']) {
      await service.navigate(assets.sessionId, assetPage.pageId, {
        url: `http://localhost:${port}/start-${terminal}`,
      });
      await expect
        .poll(
          () => hits.filter((hit) => hit.path.startsWith(`/blocked-terminal-${terminal}-`)).length
        )
        .toBeGreaterThanOrEqual(4);
    }
    expect(hits.some((hit) => hit.path === '/must-not-follow-300')).toBe(false);
    expect(hits.some((h) => h.path === '/post-document' && h.method === 'POST')).toBe(true);
    const cookies = await service.getSessionCookies(assets.sessionId);
    expect(
      cookies
        .filter((cookie) => ['postA', 'postB'].includes(cookie.name))
        .map((cookie) => cookie.name)
        .sort()
    ).toEqual(['postA', 'postB']);
    expect(
      hits.filter(
        (h) =>
          h.path.startsWith('/worker') ||
          h.host === '127.0.0.1' ||
          h.path === '/image-must-stay-denied'
      )
    ).toEqual([]);
  } finally {
    await service.shutdown();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}, 60000);
