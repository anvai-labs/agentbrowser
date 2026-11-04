// ADR-033 live reseed: the activation gates on a FakeEngine — durable ledger
// order, input exclusion, bounded quiescence, generation invalidation, the
// qualified replacement, accounting preservation and the failure semantics
// (stop, never replay). Values never appear in results or errors.
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalGate } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';
import type { SessionPrincipal } from './session-authority.js';
import { readEngagementLedgerLines } from './test-support/engagement-ledger-lines.js';

const operator = (tenant = 'owner'): SessionPrincipal => ({ actor: 'human-operator', tenant });
const refused = async (promise: Promise<unknown>): Promise<{ code: string; details: unknown }> => {
  try {
    await promise;
  } catch (error) {
    const typed = error as { code?: string; details?: unknown };
    if (typed.code === undefined) throw error;
    return { code: typed.code, details: typed.details ?? {} };
  }
  throw new Error('Expected a typed refusal');
};

let dir: string | undefined;
const services: AgentBrowserService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

interface Fixture {
  service: AgentBrowserService;
  engine: FakeEngine;
  gate: ApprovalGate;
  sessionId: string;
  scope: import('@agentbrowser/protocol').EngagementScope;
}

async function reseedFixture(
  scopeOverrides: Record<string, unknown> = {},
  createOverrides: Record<string, unknown> = {}
): Promise<Fixture> {
  dir = await mkdtemp(join(tmpdir(), 'eng-reseed-'));
  await chmod(dir, 0o700);
  const engine = new FakeEngine();
  const gate = new ApprovalGate();
  const service = new AgentBrowserService({
    engine,
    approvalGate: gate,
    engagement: { directory: await realpath(dir), maxBytes: 64 * 1024 * 1024 },
  });
  services.push(service);
  const scope: import('@agentbrowser/protocol').EngagementScope = {
    allowedHosts: ['example.com'],
    ledger: true,
    requestBudget: 100,
    authRotation: {
      refreshUrlPattern: 'https://example.com/auth/refresh',
      identityUrlPattern: 'https://example.com/api/*',
    },
    ...scopeOverrides,
  };
  const { sessionId } = await service.createSession({
    tenantId: 'owner',
    ...createOverrides,
    cookies: [
      {
        name: 'old-session',
        value: 'old-secret-value',
        domain: 'example.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    scope,
  });
  return { service, engine, gate, sessionId, scope };
}

const freshCookies = [
  {
    name: 'new-session',
    value: 'new-secret-value',
    domain: 'example.com',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  },
  {
    name: 'prefs',
    value: 'p2',
    domain: '.example.com',
    path: '/',
    secure: true,
    sameSite: 'Lax',
  },
];

const ledgerLines = () => readEngagementLedgerLines(dir as string);

describe('live reseed (ADR-033)', () => {
  it('replaces the jar under the gates and preserves scope accounting verbatim', async () => {
    const f = await reseedFixture();
    const before = f.service.getScopeStatus(f.sessionId);
    const result = await f.service.reseedSession(
      f.sessionId,
      { expectedRevision: before.revision ?? 0, cookies: freshCookies },
      operator()
    );
    expect(result.cookies).toBe(2);
    expect(result.domains).toEqual(['example.com']);
    expect(result.seedSha256).toMatch(/^[0-9a-f]{64}$/);
    // The digest is canonical: sorted, order-insensitive.
    const reordered = await f.service.reseedSession(
      f.sessionId,
      {
        expectedRevision: f.service.getScopeStatus(f.sessionId).revision ?? 0,
        cookies: [...freshCookies].reverse(),
      },
      operator()
    );
    expect(reordered.seedSha256).toBe(result.seedSha256);

    // The jar was CLEARED then replaced: create-time seeds are gone. The
    // second reseed wrote the reversed order; membership is the assertion.
    const jar = await f.engine.getFakeSession(f.engine.getSessionIds()[0] ?? '')?.cookies();
    expect(jar?.map((c) => c.name).sort()).toEqual(['new-session', 'prefs']);

    // Accounting verbatim: same revision, budget untouched, hint re-armed.
    const after = f.service.getScopeStatus(f.sessionId);
    expect(after.revision).toBe(before.revision);
    expect(after.budget).toEqual(before.budget);
    expect(after.authRotation).toMatchObject({ suspected: false });

    // Operator credentials never export after a reseed (the mark).
    expect(await refused(f.service.getSessionCookies(f.sessionId))).toMatchObject({
      code: 'HANDOFF_COOKIES_NOT_EXPORTABLE',
    });
  });

  it('ledgers authorization before any change and completion before success', async () => {
    const f = await reseedFixture();
    const revision = f.service.getScopeStatus(f.sessionId).revision ?? 0;
    await f.service.reseedSession(
      f.sessionId,
      { expectedRevision: revision, cookies: freshCookies },
      operator()
    );
    const lines = await ledgerLines();
    const types = lines.map((line) => line.type);
    const authorized = types.indexOf('auth.reseed.authorized');
    const completed = types.indexOf('auth.reseed.completed');
    expect(authorized).toBeGreaterThanOrEqual(0);
    expect(completed).toBeGreaterThan(authorized);
    const record = lines[authorized] as { data?: Record<string, unknown> };
    expect(record.data).toMatchObject({
      expectedRevision: revision,
      cookieCount: 2,
      domains: ['example.com'],
      authorizedBy: 'human-operator',
      tenantId: 'owner',
    });
    expect(record.data?.seedSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requires the human operator, the tenant, a ledger, and the reviewed revision', async () => {
    const f = await reseedFixture();
    const revision = f.service.getScopeStatus(f.sessionId).revision ?? 0;
    const cookies = freshCookies;
    expect(
      await refused(
        f.service.reseedSession(
          f.sessionId,
          { expectedRevision: revision, cookies },
          { actor: 'operator', tenant: 'owner' }
        )
      )
    ).toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await refused(
        f.service.reseedSession(
          f.sessionId,
          { expectedRevision: revision, cookies },
          operator('other')
        )
      )
    ).toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(
      await refused(
        f.service.reseedSession(
          f.sessionId,
          { expectedRevision: revision + 1, cookies },
          operator()
        )
      )
    ).toMatchObject({ code: 'INVALID_REQUEST' });

    // No ledger configured: an unrecordable reseed never runs.
    const bare = new AgentBrowserService({
      engine: new FakeEngine(),
      approvalGate: new ApprovalGate(),
    });
    services.push(bare);
    const { sessionId } = await bare.createSession({
      tenantId: 'owner',
      scope: { allowedHosts: ['example.com'] },
    });
    expect(
      await refused(bare.reseedSession(sessionId, { expectedRevision: 0, cookies }, operator()))
    ).toMatchObject({
      code: 'POLICY_DENIED',
      details: { scope: 'SCOPE_LEDGER_UNAVAILABLE' },
    });
  });

  it('excludes browser input while quiescence is pending, then completes when it settles', async () => {
    const f = await reseedFixture();
    const revision = f.service.getScopeStatus(f.sessionId).revision ?? 0;
    const page = await f.service.createPage(f.sessionId);
    const session = f.engine.getFakeSession(f.engine.getSessionIds()[0] ?? '');
    session?.pinInFlightRequests(1);
    const attempt = f.service.reseedSession(
      f.sessionId,
      { expectedRevision: revision, cookies: freshCookies, quiescenceTimeoutMs: 5000 },
      operator()
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      await refused(f.service.navigate(f.sessionId, page.pageId, { url: 'https://example.com/' }))
    ).toMatchObject({ code: 'SESSION_BUSY', details: { rule: 'reseed.input' } });
    expect(
      await refused(f.service.act(f.sessionId, page.pageId, { action: 'observe' } as never))
    ).toMatchObject({ code: 'SESSION_BUSY' });
    expect(await refused(f.service.createPage(f.sessionId))).toMatchObject({
      code: 'SESSION_BUSY',
    });
    // Review round 2 (F5): no NEW authority is minted inside the window.
    expect(
      await refused(
        f.service.grantActionLease(f.sessionId, {
          hosts: ['example.com'],
          expiresInMs: 60000,
          maxActions: 10,
        })
      )
    ).toMatchObject({ code: 'SESSION_BUSY', details: { rule: 'reseed.input' } });
    session?.pinInFlightRequests(0);
    const result = await attempt; // quiescence reached well inside the 5s bound
    expect(result.cookies).toBe(2);
    // The exclusion is released: input works again.
    await f.service.createPage(f.sessionId);
  });

  it('enforces the handoff floors: usable domains, coverage of the session hosts (F3)', async () => {
    const f = await reseedFixture();
    const revision = f.service.getScopeStatus(f.sessionId).revision ?? 0;
    // A wrong-domain reseed would silently strip the session's auth.
    await expect(
      f.service.reseedSession(
        f.sessionId,
        {
          expectedRevision: revision,
          cookies: [{ ...freshCookies[0], domain: 'other-example.com' }],
        },
        operator()
      )
    ).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { rule: 'reseed.coverage' } });
    // Unusable cookie domains refuse as invalid.
    await expect(
      f.service.reseedSession(
        f.sessionId,
        { expectedRevision: revision, cookies: [{ ...freshCookies[0], domain: '127.0.0.1' }] },
        operator()
      )
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    // Floors precede the durable authorization: nothing was recorded.
    expect((await ledgerLines()).some((line) => line.type === 'auth.reseed.authorized')).toBe(
      false
    );
  });

  it('refuses more than 100 distinct domains instead of silently truncating the floors (round 2)', async () => {
    const f = await reseedFixture();
    const revision = f.service.getScopeStatus(f.sessionId).revision ?? 0;
    const many = Array.from({ length: 101 }, (_, i) => ({
      ...freshCookies[0],
      name: `c${i}`,
      domain: `d${i}.example.com`,
    }));
    await expect(
      f.service.reseedSession(
        f.sessionId,
        { expectedRevision: revision, cookies: many },
        operator()
      )
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect((await ledgerLines()).some((line) => line.type === 'auth.reseed.authorized')).toBe(
      false
    );
  });

  it('refuses a delegated session, failing closed (round 2)', async () => {
    const delegated = await reseedFixture({}, { controlMode: 'delegated' });
    const revision = delegated.service.getScopeStatus(delegated.sessionId).revision ?? 0;
    await expect(
      delegated.service.reseedSession(
        delegated.sessionId,
        { expectedRevision: revision, cookies: freshCookies },
        operator()
      )
    ).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { rule: 'reseed.floors' } });
  });

  it('a pinned in-flight request refuses the reseed with nothing changed', async () => {
    const f = await reseedFixture();
    const session = f.engine.getFakeSession(f.engine.getSessionIds()[0] ?? '');
    session?.pinInFlightRequests(2);
    const refusal = await refused(
      f.service.reseedSession(
        f.sessionId,
        {
          expectedRevision: f.service.getScopeStatus(f.sessionId).revision ?? 0,
          cookies: freshCookies,
          quiescenceTimeoutMs: 1000,
        },
        operator()
      )
    );
    expect(refusal).toMatchObject({
      code: 'POLICY_DENIED',
      details: { scope: 'RESEED_QUIESCENCE' },
    });
    // Nothing changed: the jar is intact, no completed record, an aborted one.
    const jar = await session?.cookies();
    expect(jar?.map((c) => c.name)).toEqual(['old-session']);
    const lines = await ledgerLines();
    expect(lines.some((line) => line.type === 'auth.reseed.completed')).toBe(false);
    const aborted = lines.find((line) => line.type === 'auth.reseed.aborted') as
      | { data?: { stage?: string } }
      | undefined;
    expect(aborted?.data?.stage).toBe('quiescence');
  });

  it('kills pending approvals and leases before the write; a failed replace stops the scope', async () => {
    const f = await reseedFixture();
    const token = await f.gate.generateApprovalToken({
      sessionId: f.sessionId,
      action: { type: 'click', target: { ref: 'e1_1' } },
    });
    const revision = f.service.getScopeStatus(f.sessionId).revision ?? 0;
    f.engine.getFakeSession(f.engine.getSessionIds()[0] ?? '')?.failNextReplace();
    const refusal = await refused(
      f.service.reseedSession(
        f.sessionId,
        { expectedRevision: revision, cookies: freshCookies },
        operator()
      )
    );
    expect(refusal.code).toBe('INTERNAL');
    // The pending approval died at the generation bump, before the write.
    const after = await f.gate.getToken(token.tokenId);
    expect(after?.status).toBe('expired');
    // The scope stopped: no traffic under uncertain authority.
    expect(f.service.getScopeStatus(f.sessionId).stopped).toBe('reseed incomplete');
    const lines = await ledgerLines();
    expect(lines.some((line) => line.type === 'auth.reseed.failed')).toBe(true);
    expect(lines.some((line) => line.type === 'auth.reseed.completed')).toBe(false);
  });
});
