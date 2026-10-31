import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';

it('keeps the same page and edited form state when the operator activates a previously denied asset host', async () => {
  let port = 0;
  const assets: Array<{ marker?: string; cookie?: string }> = [];
  const fixture = createServer((req, res) => {
    if (req.url === '/asset.js') {
      assets.push({
        marker: req.headers['x-research'] as string | undefined,
        cookie: req.headers.cookie,
      });
      res.setHeader('content-type', 'application/javascript');
      res.end('document.querySelector("#loaded").textContent="asset-ready";');
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(`<body><label>Draft<input value="initial"></label><span id="loaded">asset-missing</span>
        <button onclick="const s=document.createElement('script');s.src='http://127.0.0.1:${port}/asset.js';document.body.append(s)">Retry asset</button>
        <script src="http://127.0.0.1:${port}/asset.js"></script></body>`);
    }
  });
  await new Promise<void>((r) => fixture.listen(0, r));
  port = (fixture.address() as AddressInfo).port;
  const directory = await mkdtemp(join(tmpdir(), 'amend-real-'));
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
    engagement: { directory, maxBytes: 1024 * 1024 },
  });
  try {
    const session = await service.createSession({
      tenantId: 'fixture',
      scope: {
        allowedHosts: ['localhost'],
        ledger: true,
        requestBudget: 100,
        requestHeaders: [{ header: 'x-research', value: 'fixture-marker' }],
      },
    });
    const { pageId } = await service.createPage(session.sessionId);
    await service.navigate(session.sessionId, pageId, { url: `http://localhost:${port}/` });
    let snapshot = await service.observe(session.sessionId, pageId, {});
    const input = snapshot.elements.find((e) => e.name === 'Draft');
    expect(input).toBeDefined();
    await service.act(session.sessionId, pageId, {
      type: 'fill',
      target: { ref: input!.ref },
      value: 'operator-draft',
    });
    expect(assets).toHaveLength(0);
    await service.amendScopeAssets(
      session.sessionId,
      { expectedRevision: 0, assetHosts: [{ host: '127.0.0.1', class: 'asset' }] },
      { actor: 'human-operator', tenant: 'fixture' }
    );
    snapshot = await service.observe(session.sessionId, pageId, {});
    expect(snapshot.elements.find((e) => e.name === 'Draft')?.value).toBe('operator-draft');
    const button = snapshot.elements.find((e) => e.name === 'Retry asset');
    expect(button).toBeDefined();
    await service.act(session.sessionId, pageId, { type: 'click', target: { ref: button!.ref } });
    await expect.poll(() => assets.length).toBe(1);
    expect(assets[0]).toEqual({ marker: undefined, cookie: '' });
    expect(service.getScopeStatus(session.sessionId)).toMatchObject({
      revision: 1,
      budget: { limit: 100 },
      allowedHosts: ['localhost'],
    });
    expect((await service.listPages(session.sessionId))[0]?.pageId).toBe(pageId);
  } finally {
    await service.shutdown();
    fixture.closeAllConnections();
    await new Promise<void>((r) => fixture.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
