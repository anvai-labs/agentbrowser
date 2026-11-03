// ADR-033 live reseed in a real Chromium: the engine's in-flight counter
// (a held response keeps quiescence away), the qualified replacement under
// the gates, the rotation hint clearing, ledger order and accounting
// preservation — end to end on the real choke point.
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';
import { readEngagementLedgerLines } from './test-support/engagement-ledger-lines.js';

let dir: string | undefined;

it('reseeds a live session under quiescence, replacing the jar and clearing the advisory', async () => {
  dir = await mkdtemp(join(tmpdir(), 'eng-reseed-live-'));
  await chmod(dir, 0o700);

  const seen: Array<{ path: string; cookie: string }> = [];
  let releaseHang: (() => void) | undefined;
  const hangGate = new Promise<void>((resolve) => {
    releaseHang = resolve;
  });
  let port = 0;
  const fixture = createServer((req, res) => {
    const record = () => seen.push({ path: req.url ?? '/', cookie: req.headers.cookie ?? '' });
    if (req.url === '/hang') {
      record();
      void hangGate.then(() => {
        res.setHeader('content-type', 'text/plain');
        res.end('released');
      });
      return;
    }
    if (req.url === '/api/me') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    record();
    if (req.url === '/auth/refresh') {
      res.setHeader('content-type', 'text/html');
      res.end(`<body><script>fetch('/api/me').catch(() => {});</script></body>`);
      return;
    }
    if (req.url === '/hangpage') {
      res.setHeader('content-type', 'text/html');
      res.end(`<body><script>fetch('/hang').catch(() => {});</script></body>`);
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<body><h1>ok</h1></body>');
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  port = (fixture.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
    engagement: { directory: await realpath(dir), maxBytes: 64 * 1024 * 1024 },
  });
  try {
    const session = await service.createSession({
      tenantId: 'fixture',
      cookies: [
        {
          name: 'session',
          value: 'old-live-secret',
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      scope: {
        allowedHosts: ['127.0.0.1'],
        ledger: true,
        requestBudget: 500,
        authRotation: {
          refreshUrlPattern: `${origin}/auth/refresh`,
          identityUrlPattern: `${origin}/api/*`,
        },
      },
    });
    const { pageId } = await service.createPage(session.sessionId);
    await service.navigate(session.sessionId, pageId, { url: `${origin}/` });
    await expect.poll(() => seen.filter((row) => row.path === '/').length).toBeGreaterThan(0);
    expect(seen.find((row) => row.path === '/')?.cookie).toContain('old-live-secret');

    // Drive the rotation advisory: refresh navigation then a 401 on identity.
    await service.navigate(session.sessionId, pageId, { url: `${origin}/auth/refresh` });
    await expect
      .poll(() => service.getScopeStatus(session.sessionId).authRotation?.suspected)
      .toBe(true);

    // A held response keeps the engine's in-flight count above zero: the
    // reseed must refuse with nothing changed.
    await service.navigate(session.sessionId, pageId, { url: `${origin}/hangpage` });
    await expect.poll(() => seen.some((row) => row.path === '/hang')).toBe(true);
    const busyStatus = service.getScopeStatus(session.sessionId);
    await expect(
      service.reseedSession(
        session.sessionId,
        {
          expectedRevision: busyStatus.revision ?? 0,
          quiescenceTimeoutMs: 1000,
          cookies: [
            {
              name: 'session',
              value: 'new-live-secret',
              domain: '127.0.0.1',
              path: '/',
              httpOnly: true,
              secure: false,
              sameSite: 'Lax',
            },
          ],
        },
        { actor: 'human-operator', tenant: 'fixture' }
      )
    ).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { scope: 'RESEED_QUIESCENCE' } });

    // Release; the reseed completes and the jar is genuinely replaced.
    // Under a loaded suite the settling traffic can outlast one bounded
    // wait; a quiescence refusal changes nothing, so the operator's honest
    // move — retry the gate — is also the test's: a few attempts, each a
    // real gate pass, until one completes.
    releaseHang?.();
    let result: Awaited<ReturnType<typeof service.reseedSession>> | undefined;
    for (let attempt = 0; attempt < 4 && result === undefined; attempt += 1) {
      try {
        result = await service.reseedSession(
          session.sessionId,
          {
            expectedRevision: busyStatus.revision ?? 0,
            quiescenceTimeoutMs: 10000,
            cookies: [
              {
                name: 'session',
                value: 'new-live-secret',
                domain: '127.0.0.1',
                path: '/',
                httpOnly: true,
                secure: false,
                sameSite: 'Lax',
              },
            ],
          },
          { actor: 'human-operator', tenant: 'fixture' }
        );
      } catch (error) {
        const typed = error as { code?: string; details?: { scope?: string } };
        if (typed.code !== 'POLICY_DENIED' || typed.details?.scope !== 'RESEED_QUIESCENCE')
          throw error;
      }
    }
    expect(result?.cookies).toBe(1);
    expect(result.authRotationSuspected).toBe(false);

    const after = service.getScopeStatus(session.sessionId);
    expect(after.authRotation?.suspected).toBe(false);
    expect(after.revision).toBe(busyStatus.revision); // renewal is not an amendment
    expect(after.budget?.limit).toBe(busyStatus.budget?.limit);

    // The very next document carries the NEW credential and not the old one.
    const baseline = seen.length;
    await service.navigate(session.sessionId, pageId, { url: `${origin}/after` });
    await expect.poll(() => seen.length).toBeGreaterThan(baseline);
    const afterRow = seen[seen.length - 1];
    expect(afterRow.path).toBe('/after');
    expect(afterRow.cookie).toContain('new-live-secret');
    expect(afterRow.cookie).not.toContain('old-live-secret');

    // Ledger order: authorized precedes completed, both carrying the digest.
    const lines = await readEngagementLedgerLines(dir as string);
    const types = lines.map((line) => line.type);
    expect(types.indexOf('auth.reseed.authorized')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('auth.reseed.completed')).toBeGreaterThan(
      types.indexOf('auth.reseed.authorized')
    );
    expect(types).toContain('auth.reseed.aborted'); // the quiescence refusal is recorded
    const completed = lines.find((line) => line.type === 'auth.reseed.completed') as
      | { data?: Record<string, unknown> }
      | undefined;
    expect(completed?.data?.seedSha256).toBe(result.seedSha256);

    await service.closeSession(session.sessionId);
  } finally {
    await service.shutdown();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
}, 90000);
