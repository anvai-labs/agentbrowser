// ADR-033 live reseed in a real Chromium: the engine's in-flight counter
// (a held response keeps quiescence away), the qualified replacement under
// the gates, the rotation hint clearing, ledger order and accounting
// preservation — end to end on the real choke point. The second suite pins
// the review-F1 admission freeze: a Set-Cookie poller cannot poison a
// completed reseed.
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';
import { readEngagementLedgerLines } from './test-support/engagement-ledger-lines.js';

// The reseed floors require registrable cookie domains (like the handoff),
// so the fixture rides on localtest.me — a registrable domain whose public
// DNS resolves to 127.0.0.1 (the suite already resolves public DNS).
const HOST = 'localtest.me';

let dir: string | undefined;

// --- the shared fixture -----------------------------------------------------
const seen: Array<{ path: string; cookie: string }> = [];
let releaseHang: (() => void) | undefined;
let hangGate: Promise<void> | undefined;
let fixture: Server | undefined;
let origin = '';

beforeAll(async () => {
  hangGate = new Promise<void>((resolve) => {
    releaseHang = resolve;
  });
  const server = createServer((req, res) => {
    const record = () => seen.push({ path: req.url ?? '/', cookie: req.headers.cookie ?? '' });
    if (req.url === '/hang') {
      record();
      void hangGate?.then(() => {
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
    if (req.url === '/recookie') {
      // The poisoned-jar probe (review F1): each response carries its ISSUE
      // TIME as the value, so a cookie that raced the reseed write is
      // distinguishable from one legitimately set afterwards.
      res.setHeader('set-cookie', `rotated-back=${Date.now()}`);
      res.end('ok');
      return;
    }
    if (req.url === '/pollpage') {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<body><script>(async () => { for (let i = 0; i < 10; i++) { await fetch('/recookie').catch(() => {}); await new Promise(r => setTimeout(r, 60)); } })();</script></body>`
      );
      return;
    }
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `http://${HOST}:${port}`;
  fixture = server;
});

afterAll(async () => {
  fixture?.closeAllConnections();
  await new Promise<void>((resolve) => fixture?.close(() => resolve()));
});

const newService = async () => {
  dir = await mkdtemp(join(tmpdir(), 'eng-reseed-live-'));
  await chmod(dir, 0o700);
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy({ blockLoopback: false, blockPrivateIPs: false }),
    engagement: { directory: await realpath(dir), maxBytes: 64 * 1024 * 1024 },
  });
  return service;
};

const cleanup = async (service: AgentBrowserService) => {
  await service.shutdown();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
};

const readLedger = () => readEngagementLedgerLines(dir as string);

const seedCookie = (value: string) => [
  {
    name: 'session',
    value,
    domain: HOST,
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'Lax' as const,
  },
];

const reseedOrFail = async (
  service: AgentBrowserService,
  sessionId: string,
  cookies: Array<Record<string, unknown>>,
  options: { quiescenceTimeoutMs?: number; attempts?: number } = {}
) => {
  const revision = () => service.getScopeStatus(sessionId).revision ?? 0;
  for (let attempt = 0; attempt < (options.attempts ?? 1); attempt += 1) {
    try {
      return await service.reseedSession(
        sessionId,
        {
          expectedRevision: revision(),
          ...(options.quiescenceTimeoutMs !== undefined
            ? { quiescenceTimeoutMs: options.quiescenceTimeoutMs }
            : {}),
          cookies: cookies as never,
        },
        { actor: 'human-operator', tenant: 'fixture' }
      );
    } catch (error) {
      const typed = error as { code?: string; details?: { scope?: string } };
      if (typed.code !== 'POLICY_DENIED' || typed.details?.scope !== 'RESEED_QUIESCENCE')
        throw error;
    }
  }
  return undefined;
};

it('reseeds a live session under quiescence, replacing the jar and clearing the advisory', async () => {
  const service = await newService();
  try {
    const session = await service.createSession({
      tenantId: 'fixture',
      cookies: seedCookie('old-live-secret') as never,
      scope: {
        allowedHosts: [HOST],
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
      reseedOrFail(service, session.sessionId, seedCookie('new-live-secret'), {
        quiescenceTimeoutMs: 1000,
      })
    ).resolves.toBeUndefined(); // refused on quiescence

    // Release; the reseed completes and the jar is genuinely replaced. Under
    // a loaded suite the settling traffic can outlast one bounded wait; a
    // quiescence refusal changes nothing, so the operator's honest move —
    // retry the gate — is also the test's.
    releaseHang?.();
    const result = await reseedOrFail(service, session.sessionId, seedCookie('new-live-secret'), {
      quiescenceTimeoutMs: 15000,
      attempts: 6,
    });
    expect(result?.cookies).toBe(1);
    expect(result?.authRotationSuspected).toBe(false);

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
    const lines = await readLedger();
    const types = lines.map((line) => line.type);
    expect(types.indexOf('auth.reseed.authorized')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('auth.reseed.completed')).toBeGreaterThan(
      types.indexOf('auth.reseed.authorized')
    );
    expect(types).toContain('auth.reseed.aborted'); // the quiescence refusal is recorded
    const completed = lines.find((line) => line.type === 'auth.reseed.completed') as
      | { data?: Record<string, unknown> }
      | undefined;
    expect(completed?.data?.seedSha256).toBe(result?.seedSha256);

    await service.closeSession(session.sessionId);
  } finally {
    await cleanup(service);
  }
}, 240000);

// Review F1 regression: the admission freeze. A page hammering a Set-Cookie
// endpoint across the reseed window must never land a PRE-completion cookie
// on the freshly written jar — the reseed either refuses (quiescence) or the
// freeze parks the racing request until the write completes.
it('a Set-Cookie poller cannot poison a completed reseed (admission freeze)', async () => {
  const service = await newService();
  try {
    const session = await service.createSession({
      tenantId: 'fixture',
      scope: { allowedHosts: [HOST], ledger: true, requestBudget: 500 },
    });
    const { pageId } = await service.createPage(session.sessionId);
    // Establish the baseline jar the poller will try to overwrite back.
    await reseedOrFail(service, session.sessionId, seedCookie('fresh-seed'));
    await service.navigate(session.sessionId, pageId, { url: `${origin}/pollpage` });
    await new Promise((resolve) => setTimeout(resolve, 120)); // poller running
    const result = await reseedOrFail(service, session.sessionId, seedCookie('fresh-seed'), {
      quiescenceTimeoutMs: 2000,
      attempts: 4,
    });
    expect(result).toBeDefined();
    const completedAt = Date.now();
    // Let the bounded poller finish and the jar settle, then read it on the
    // wire: any rotated-back value older than completion is the F1 poison.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const baseline = seen.length;
    await service.navigate(session.sessionId, pageId, { url: `${origin}/after-freeze` });
    await expect.poll(() => seen.length).toBeGreaterThan(baseline);
    const cookie = seen[seen.length - 1]?.cookie ?? '';
    expect(cookie).toContain('fresh-seed');
    const raced = /rotated-back=(\d+)/.exec(cookie)?.[1];
    expect(
      raced === undefined || Number(raced) >= completedAt,
      `poisoned jar: rotated-back=${raced ?? 'none'} predates completion ${completedAt}`
    ).toBe(true);
    await service.closeSession(session.sessionId);
  } finally {
    await cleanup(service);
  }
}, 240000);
