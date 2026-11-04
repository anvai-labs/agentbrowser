// Review round 2, Finding 1: the cross-origin inspected lane must carry
// BODILESS non-GET/HEAD requests (DELETE, bodiless POST beacons) exactly as
// it did before the lost-body guard — postDataBuffer() is null for "no body"
// and "lost body" alike, and the request's own headers say which. Pinned in
// real Chromium after the guard regressed the bodiless case.
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';
import { startLoopbackHitServer } from './test-support/loopback-hit-server.js';

it('cross-origin bodiless DELETE and POST ride the inspected lane unchanged', async () => {
  const hits: Array<{ host: string; path: string; method: string; body: string }> = [];
  const fixture = await startLoopbackHitServer((request, res, port) => {
    hits.push(request);
    if (request.host === 'localhost') {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      `<body><script>
fetch('http://localhost:${port}/bye', {method: 'DELETE'}).catch(() => {});
fetch('http://localhost:${port}/ping', {method: 'POST'}).catch(() => {});
fetch('http://localhost:${port}/beacon', {method: 'POST', body: '{"t":1}', headers: {'content-type': 'text/plain'}}).catch(() => {});
</script></body>`
    );
  });
  const port = fixture.port;
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
  });
  try {
    const session = await service.createSession({
      tenantId: 'fixture',
      // Two PROGRAM hosts: the cross-origin requests are same-policy traffic
      // on the inspected lane (127.0.0.1 -> localhost is cross-origin).
      scope: { allowedHosts: ['127.0.0.1', 'localhost'] },
    });
    const { pageId } = await service.createPage(session.sessionId);
    await service.navigate(session.sessionId, pageId, { url: `http://127.0.0.1:${port}/` });
    await expect.poll(() => hits.filter((h) => h.host === 'localhost').length).toBe(3);
    // The bodiless DELETE and bodiless POST land with empty bodies; the
    // body-bearing POST keeps its exact bytes.
    expect(hits.find((h) => h.path === '/bye')).toMatchObject({ method: 'DELETE', body: '' });
    expect(hits.find((h) => h.path === '/ping')).toMatchObject({ method: 'POST', body: '' });
    expect(hits.find((h) => h.path === '/beacon')).toMatchObject({
      method: 'POST',
      body: '{"t":1}',
    });
  } finally {
    await service.shutdown();
    await fixture.close();
  }
}, 60000);
