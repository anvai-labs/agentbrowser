import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';

it('reuses cookie and exact-origin localStorage login in a fresh evidence context', async () => {
  const fixture = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/login') {
      res.setHeader('set-cookie', [
        'auth=synthetic-evidence-cookie; HttpOnly; Path=/; SameSite=Lax',
        'pathauth=synthetic-path-cookie; HttpOnly; Path=/verify; SameSite=Lax',
      ]);
      res.end('<script>localStorage.setItem("auth", "synthetic-storage-token")</script>signed in');
    } else {
      res.end(`<div id="result">${req.headers.cookie?.includes('auth=synthetic-evidence-cookie') && req.headers.cookie?.includes('pathauth=synthetic-path-cookie') ? 'cookie-ready' : 'no-cookie'}</div>
        <script>document.querySelector('#result').append(localStorage.getItem('auth') === 'synthetic-storage-token' ? ' storage-ready' : ' no-storage')</script>`);
    }
  });
  const other = createServer((_req, res) =>
    res.end(
      '<p>other origin</p><script>document.body.append(localStorage.getItem("auth") ? "unexpected-storage" : "no-storage")</script>'
    )
  );
  await Promise.all([
    new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r)),
    new Promise<void>((r) => other.listen(0, '127.0.0.1', r)),
  ]);
  const port = (fixture.address() as AddressInfo).port;
  const otherPort = (other.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const directory = await mkdtemp(join(tmpdir(), 'evidence-real-'));
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
    engagement: { directory, maxBytes: 1024 * 1024 },
    authorizer: {
      version: 'fixture',
      decide: () => ({ allowed: true, reason: 'fixture', rulesMatched: [] }),
    },
  });
  try {
    const source = await service.createSession({ tenantId: 'one', headless: true });
    const page = await service.createPage(source.sessionId);
    await service.navigate(source.sessionId, page.pageId, { url: `${origin}/login` });
    const target = await service.createEvidenceSession(
      source.sessionId,
      {
        headless: true,
        origins: [origin],
        scope: {
          allowedHosts: ['127.0.0.1'],
          allowedSchemes: ['http'],
          allowedPorts: [port, otherPort],
          ledger: true,
        },
      },
      { actor: 'human-operator', tenant: 'one' }
    );
    const evidence = await service.createPage(target.sessionId);
    await service.navigate(target.sessionId, evidence.pageId, { url: `${origin}/verify` });
    const result = await service.extract(target.sessionId, evidence.pageId, { format: 'text' });
    expect(JSON.stringify(result)).toContain('cookie-ready storage-ready');
    await service.navigate(target.sessionId, evidence.pageId, {
      url: `http://127.0.0.1:${otherPort}/`,
    });
    expect(
      JSON.stringify(await service.extract(target.sessionId, evidence.pageId, { format: 'text' }))
    ).toContain('no-storage');
  } finally {
    await service.shutdown();
    fixture.closeAllConnections();
    other.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => fixture.close(() => r())),
      new Promise<void>((r) => other.close(() => r())),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
