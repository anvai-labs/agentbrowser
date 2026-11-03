// P1-6a (ADR-033): rotation detection end to end in a real Chromium — a
// refresh-bounce navigation followed by a 401 on the identity endpoint sets
// the scope-status hint and appends exactly one advisory ledger event.
// Advisory only: traffic itself is never denied by detection.
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { afterEach, expect, it } from 'vitest';
import { buildServer } from './server.js';

const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');
let dir: string | undefined;
const savedDir = process.env.AGENTBROWSER_ENGAGEMENT_DIR;
afterEach(async () => {
  if (savedDir === undefined) delete process.env.AGENTBROWSER_ENGAGEMENT_DIR;
  else process.env.AGENTBROWSER_ENGAGEMENT_DIR = savedDir;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

it('a refresh bounce followed by a 401 on identity suspects rotation, once', async () => {
  dir = await mkdtemp(join(tmpdir(), 'eng-rotation-'));
  await chmod(dir, 0o700);
  // macOS can expose tmpdir() through a symlink; valid fixtures must be canonical.
  process.env.AGENTBROWSER_ENGAGEMENT_DIR = await realpath(dir);

  let port = 0;
  const fixture = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/api/me') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    // The program page immediately bounces through the refresh navigation;
    // the refresh document then asks the identity endpoint.
    const body =
      url === '/auth/refresh'
        ? `<body><h1>refreshed</h1><script>fetch('/api/me').catch(() => {});</script></body>`
        : `<body><script>location.replace('/auth/refresh');</script></body>`;
    res.setHeader('content-type', 'text/html');
    res.end(body);
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  port = (fixture.address() as AddressInfo).port;

  const app = await buildServer({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
    apiKeys: new Map([[keyHash('key-rotation'), 'rotation-tenant']]),
  });
  try {
    const as = { authorization: 'Bearer key-rotation' };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: as,
      payload: {
        tenantId: 'rotation-tenant',
        policy: {
          scope: {
            allowedHosts: ['127.0.0.1'],
            ledger: true,
            authRotation: {
              refreshUrlPattern: 'http://127.0.0.1:*/auth/refresh',
              identityUrlPattern: 'http://127.0.0.1:*/api/me',
            },
          },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { sessionId, engagementId } = created.json();
    const page = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/pages`,
      headers: as,
    });
    const { pageId } = page.json();
    await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/pages/${pageId}/navigate`,
      headers: as,
      payload: { url: `http://127.0.0.1:${port}/` },
    });

    // The signature completes: hint set in the scope status.
    await expect
      .poll(async () => {
        const status = await app.inject({
          method: 'GET',
          url: `/v1/sessions/${sessionId}/scope`,
          headers: as,
        });
        return status.json().authRotation?.suspected;
      })
      .toBe(true);

    // Exactly one advisory ledger event, origin+path only, with the
    // completing status — never the query, never repeated.
    const exportResponse = await app.inject({
      method: 'GET',
      url: `/v1/engagements/${engagementId}`,
      headers: as,
    });
    expect(exportResponse.statusCode).toBe(200);
    const advisories = exportResponse.body
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
      .filter((record) => record.type === 'auth.rotation-suspected');
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({
      data: {
        refresh: `http://127.0.0.1:${port}/auth/refresh`,
        identity: `http://127.0.0.1:${port}/api/me`,
        status: 401,
      },
    });

    await app.inject({ method: 'DELETE', url: `/v1/sessions/${sessionId}`, headers: as });
  } finally {
    await app.close();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}, 60000);
