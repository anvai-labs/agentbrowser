import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalGate, SecretManager } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { AgentBrowserService, type ServiceDependencies } from './service.js';

/**
 * TD-BROWSER-16 phase 6 (ADR-025 §3): the cookie handoff. The login browser
 * is a fake seam (isEnabled/isOpen/read with mutable cookie state); the
 * session side runs on FakeEngine, whose addCookies/addInitScript record the
 * real writes the handoff makes.
 */

type LoginCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
};

function fakeLoginBrowser() {
  const state = {
    open: true,
    cookies: [] as LoginCookie[],
    skipped: { partitioned: 0, expired: 0 },
  };
  const browser: NonNullable<ServiceDependencies['loginBrowser']> = {
    isEnabled: true,
    get isOpen() {
      return state.open;
    },
    read: async () => ({
      cookies: structuredClone(state.cookies),
      skipped: { ...state.skipped },
    }),
  };
  return { browser, state };
}

const cookie = (overrides: Partial<LoginCookie> = {}): LoginCookie => ({
  name: 'session',
  value: 'operator-secret-value',
  domain: 'example.com',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  ...overrides,
});

const services: AgentBrowserService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
});

interface Fixture {
  service: AgentBrowserService;
  gate: ApprovalGate;
  secrets: SecretManager;
  engine: FakeEngine;
  sessionId: string;
  login: ReturnType<typeof fakeLoginBrowser>;
  secretSpy: ReturnType<typeof vi.spyOn>;
}

async function handoffFixture(
  options: {
    create?: Parameters<AgentBrowserService['createSession']>[0];
    authorizer?: ServiceDependencies['authorizer'];
    login?: ReturnType<typeof fakeLoginBrowser>;
  } = {}
): Promise<Fixture> {
  const engine = new FakeEngine();
  const gate = new ApprovalGate();
  const secrets = new SecretManager();
  const login = options.login ?? fakeLoginBrowser();
  const service = new AgentBrowserService({
    engine,
    approvalGate: gate,
    secretManager: secrets,
    loginBrowser: login.browser,
    ...(options.authorizer ? { authorizer: options.authorizer } : {}),
  });
  services.push(service);
  const { sessionId } = await service.createSession({
    tenantId: 'owner',
    ...(options.create ?? {}),
  });
  const secretSpy = vi.spyOn(secrets, 'registerSessionSecret');
  return { service, gate, secrets, engine, sessionId, login, secretSpy };
}

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

const ruleOf = (refusal: { details: unknown }): string =>
  (refusal.details as { rule?: string }).rule ?? '';

describe('the handoff floors (ADR-025 s3 step 1)', () => {
  it('refuses when the login browser is closed or disabled', async () => {
    const f = await handoffFixture();
    f.login.state.open = false;
    const closed = await refused(
      f.service.handoffCookies(f.sessionId, { domains: ['example.com'] })
    );
    expect(closed.code).toBe('FORBIDDEN');
    expect(ruleOf(closed)).toBe('floor.handoff.login-browser');
  });

  it('refuses a delegated session, service workers, and committed navigation', async () => {
    const delegated = await handoffFixture({ create: { controlMode: 'delegated' } });
    const refusal = await refused(
      delegated.service.handoffCookies(delegated.sessionId, { domains: ['example.com'] })
    );
    expect(ruleOf(refusal)).toBe('floor.handoff.session');

    const sw = await handoffFixture({ create: { allowServiceWorkers: true } });
    const swRefusal = await refused(
      sw.service.handoffCookies(sw.sessionId, { domains: ['example.com'] })
    );
    expect(ruleOf(swRefusal)).toBe('floor.handoff.service-workers');

    const nav = await handoffFixture();
    const page = await nav.service.createPage(nav.sessionId);
    const raw = nav.engine.getFakePage(nav.engine.getSessionIds()[0] ?? '', page.pageId);
    if (!raw) throw new Error('Expected an engine page');
    await raw.navigate({ url: 'https://example.com/start' });
    const navRefusal = await refused(
      nav.service.handoffCookies(nav.sessionId, { domains: ['example.com'] })
    );
    expect(ruleOf(navRefusal)).toBe('floor.handoff.navigation');
  });

  it('refuses a session that already holds cookies for a requested domain', async () => {
    const f = await handoffFixture({
      create: {
        cookies: [
          {
            name: 'agent-seed',
            value: 'x',
            domain: 'example.com',
            path: '/',
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
          },
        ],
      },
    });
    const refusal = await refused(
      f.service.handoffCookies(f.sessionId, { domains: ['example.com'] })
    );
    expect(ruleOf(refusal)).toBe('floor.handoff.existing-cookies');
  });

  it('refuses ".com", and allowlist entries outside the requested domains', async () => {
    const suffix = await handoffFixture();
    const suffixRefusal = await refused(
      suffix.service.handoffCookies(suffix.sessionId, { domains: ['.com'] })
    );
    expect(ruleOf(suffixRefusal)).toBe('floor.handoff.domains');

    const split = await handoffFixture({
      create: { allowedHosts: ['github.com', 'evil.org'] },
    });
    const splitRefusal = await refused(
      split.service.handoffCookies(split.sessionId, { domains: ['github.com'] })
    );
    expect(ruleOf(splitRefusal)).toBe('floor.handoff.allowlist');

    const broad = await handoffFixture({
      create: {
        scope: {
          allowedHosts: ['example.com'],
          pathRules: [{ hostSuffix: 'evil.org', prefix: '/' }],
        },
      },
    });
    broad.login.state.cookies = [cookie()];
    const broadRefusal = await refused(
      broad.service.handoffCookies(broad.sessionId, { domains: ['example.com'] })
    );
    expect(ruleOf(broadRefusal)).toBe('floor.handoff.allowlist');
  });

  it('a policy deny for one domain fails the whole handoff', async () => {
    const denyHandoff = {
      version: 'test-deny-handoff',
      decide: (request: { action: string; context: { domain?: string } }) =>
        request.action === 'cookie.handoff' && request.context.domain === 'evil.org'
          ? { allowed: false, reason: 'test deny', rulesMatched: ['rule.deny-evil'] }
          : { allowed: true, reason: 'test allow', rulesMatched: [] },
    };
    const f = await handoffFixture({ authorizer: denyHandoff });
    f.login.state.cookies = [cookie({ domain: 'example.com' }), cookie({ domain: 'evil.org' })];
    const refusal = await refused(
      f.service.handoffCookies(f.sessionId, { domains: ['example.com', 'evil.org'] })
    );
    expect(refusal.code).toBe('POLICY_DENIED');
    expect(refusal.details).toMatchObject({ domain: 'evil.org' });
  });
});

describe('the handoff approval and completion (ADR-025 s3 steps 3-8)', () => {
  let keysDir: string | undefined;
  afterEach(async () => {
    if (keysDir !== undefined) await rm(keysDir, { recursive: true, force: true });
    keysDir = undefined;
    delete process.env.AGENTBROWSER_OPERATOR_KEYS_FILE;
    delete process.env.AGENTBROWSER_API_KEYS;
  });

  it('needs the operator decision; the retry with the decided token completes the handoff', async () => {
    const f = await handoffFixture();
    f.login.state.cookies = [
      cookie({ name: 'session', value: 'operator-secret-value' }),
      cookie({ name: 'other', value: 'another-operator-value', domain: 'example.com' }),
    ];
    const first = await refused(
      f.service.handoffCookies(f.sessionId, { domains: ['example.com'] })
    );
    expect(first.code).toBe('APPROVAL_REQUIRED');
    expect(first.details).toMatchObject({
      kind: 'cookie.handoff',
      sessionId: f.sessionId,
      domains: ['example.com'],
      counts: { cookies: 2, partitioned: 0, expired: 0 },
    });
    const tokenId = (first.details as { tokenId: string }).tokenId;

    // The operator approves through the non-act decide path (human-operator
    // only at the route; the service method is the same seam).
    await f.service.decideNonActApproval(f.sessionId, tokenId, 'approve');

    const result = await f.service.handoffCookies(f.sessionId, {
      domains: ['example.com'],
      approvalToken: tokenId,
    });
    expect(result).toMatchObject({
      sessionId: f.sessionId,
      credentialSource: 'operator',
      domains: ['example.com'],
    });
    expect(f.service.getSession(f.sessionId)?.credentialSource).toBe('operator');
    // The write landed, and both operator values are registered secrets.
    const fakeSession = f.engine.getSession(f.engine.getSessionIds()[0] ?? '');
    if (!fakeSession) throw new Error('Expected an engine session');
    const sessionCookies = await fakeSession.cookies();
    expect(sessionCookies.map((c) => c.name).sort()).toEqual(['other', 'session']);
    expect(f.secretSpy).toHaveBeenCalledWith(f.sessionId, 'operator-secret-value');
    expect(f.secretSpy).toHaveBeenCalledWith(f.sessionId, 'another-operator-value');
    // The RTC-removal init script is installed on the live session.
    expect(fakeSession.initScripts.join('\n')).toContain('RTCPeerConnection');
    // The single-use token cannot drive a second handoff (the session now
    // holds cookies, so the floor refuses first — use a fresh session to
    // prove token reuse alone fails).
    const second = await handoffFixture({ login: f.login });
    const reuse = await refused(
      second.service.handoffCookies(second.sessionId, {
        domains: ['example.com'],
        approvalToken: tokenId,
      })
    );
    expect(reuse.code).toBe('APPROVAL_REQUIRED');
  });

  it('the binding survives count changes and fails when a domain goes some-to-none', async () => {
    const f = await handoffFixture();
    f.login.state.cookies = [cookie({ name: 'session', value: 'v1' })];
    const first = await refused(
      f.service.handoffCookies(f.sessionId, { domains: ['example.com'] })
    );
    const tokenId = (first.details as { tokenId: string }).tokenId;
    // MORE cookies after the mint: the binding is kind+session+domains+policy
    // version, never the counts — the retry still succeeds.
    f.login.state.cookies.push(cookie({ name: 'extra', value: 'v2' }));
    await f.service.decideNonActApproval(f.sessionId, tokenId, 'approve');
    const result = await f.service.handoffCookies(f.sessionId, {
      domains: ['example.com'],
      approvalToken: tokenId,
    });
    expect(result.counts).toMatchObject({ cookies: 2 });

    // some -> none between mint and retry: refused, never an empty write.
    const g = await handoffFixture();
    g.login.state.cookies = [cookie({ name: 'session', value: 'v1' })];
    const mint = await refused(g.service.handoffCookies(g.sessionId, { domains: ['example.com'] }));
    const tok = (mint.details as { tokenId: string }).tokenId;
    g.login.state.cookies = [];
    await g.service.decideNonActApproval(g.sessionId, tok, 'approve');
    const gone = await refused(
      g.service.handoffCookies(g.sessionId, { domains: ['example.com'], approvalToken: tok })
    );
    expect(gone.code).toBe('FORBIDDEN');
    expect(ruleOf(gone)).toBe('floor.handoff.freshness');
    expect(g.service.getSession(g.sessionId)?.credentialSource).toBeUndefined();
  });

  it('a decided lease is applied with the marking', async () => {
    const f = await handoffFixture({ create: { allowedHosts: ['example.com'] } });
    f.login.state.cookies = [cookie({ name: 'session', value: 'v1' })];
    const first = await refused(
      f.service.handoffCookies(f.sessionId, { domains: ['example.com'] })
    );
    const tokenId = (first.details as { tokenId: string }).tokenId;
    await f.service.decideNonActApproval(f.sessionId, tokenId, 'approve', {
      hosts: ['example.com'],
      expiresInMs: 60_000,
      maxActions: 10,
    });
    const result = await f.service.handoffCookies(f.sessionId, {
      domains: ['example.com'],
      approvalToken: tokenId,
    });
    expect(result.lease).toMatchObject({ hosts: ['example.com'], maxActions: 10 });
    expect(f.service.getSession(f.sessionId)?.actionLease).toMatchObject({
      remainingActions: 10,
    });
  });

  it('the marked session refuses cookie, HTML and download export', async () => {
    const f = await handoffFixture();
    f.login.state.cookies = [cookie()];
    const first = await refused(
      f.service.handoffCookies(f.sessionId, { domains: ['example.com'] })
    );
    const tokenId = (first.details as { tokenId: string }).tokenId;
    await f.service.decideNonActApproval(f.sessionId, tokenId, 'approve');
    await f.service.handoffCookies(f.sessionId, {
      domains: ['example.com'],
      approvalToken: tokenId,
    });
    // A racing or later cookie export is refused — the mark preceded the write.
    const cookies = await refused(f.service.getSessionCookies(f.sessionId));
    expect(cookies.code).toBe('HANDOFF_COOKIES_NOT_EXPORTABLE');
    const page = await f.service.createPage(f.sessionId);
    const html = await refused(f.service.exportHtml(f.sessionId, page.pageId));
    expect(html.code).toBe('HANDOFF_COOKIES_NOT_EXPORTABLE');
    const download = await refused(
      f.service.collectDownload(f.sessionId, page.pageId, 'report.csv')
    );
    expect(download.code).toBe('HANDOFF_COOKIES_NOT_EXPORTABLE');
  });

  it('the route and the human-operator decide over HTTP; an API key cannot decide', async () => {
    keysDir = await mkdtemp(join(tmpdir(), 'handoff-keys-'));
    const file = join(keysDir, 'operator.keys');
    const operatorKey = 'operator-key-handoff-01';
    await writeFile(file, `${operatorKey}:owner\n`, 'utf8');
    process.env.AGENTBROWSER_OPERATOR_KEYS_FILE = file;
    process.env.AGENTBROWSER_API_KEYS = 'api-key-aaaaaaaaaaaa:owner';
    const login = fakeLoginBrowser();
    login.state.cookies = [cookie()];
    const engine = new FakeEngine();
    const server = await buildServer({ engine, loginBrowserPort: login.browser });
    try {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: { authorization: 'Bearer api-key-aaaaaaaaaaaa' },
        payload: { tenantId: 'owner', policy: { allowedHosts: ['example.com'] } },
      });
      expect(created.statusCode).toBe(201);
      const sessionId = created.json().sessionId as string;
      const url = `/v1/sessions/${sessionId}/cookies/handoff`;
      const pre = await server.inject({
        method: 'POST',
        url,
        headers: { authorization: 'Bearer api-key-aaaaaaaaaaaa' },
        payload: { domains: ['example.com'] },
      });
      expect(pre.statusCode).toBe(403);
      expect(pre.json().error.code).toBe('APPROVAL_REQUIRED');
      const tokenId = pre.json().error.details.tokenId as string;

      // An API-key operator cannot decide the handoff approval.
      const agentDecide = await server.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/approvals/${tokenId}`,
        headers: { authorization: 'Bearer api-key-aaaaaaaaaaaa' },
        payload: { decision: 'approve' },
      });
      expect(agentDecide.statusCode).toBe(403);

      // The human operator decides (with a lease), the agent retry completes.
      const decide = await server.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/approvals/${tokenId}`,
        headers: { authorization: `Bearer ${operatorKey}` },
        payload: {
          decision: 'approve',
          lease: { hosts: ['example.com'], expiresInMs: 1000, maxActions: 5 },
        },
      });
      expect(decide.statusCode).toBe(200);
      const done = await server.inject({
        method: 'POST',
        url,
        headers: { authorization: 'Bearer api-key-aaaaaaaaaaaa' },
        payload: { domains: ['example.com'], approvalToken: tokenId },
      });
      expect(done.statusCode).toBe(200);
      expect(done.json()).toMatchObject({ credentialSource: 'operator' });
      const view = await server.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionId}`,
        headers: { authorization: 'Bearer api-key-aaaaaaaaaaaa' },
      });
      expect(view.json().credentialSource).toBe('operator');
      expect(view.json().actionLease).toMatchObject({ remainingActions: 5 });
      // And the cookies are no longer exportable.
      const exportAttempt = await server.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionId}/cookies`,
        headers: { authorization: 'Bearer api-key-aaaaaaaaaaaa' },
      });
      expect(exportAttempt.statusCode).toBe(403);
      expect(exportAttempt.json().error.code).toBe('HANDOFF_COOKIES_NOT_EXPORTABLE');
    } finally {
      await server.close();
    }
  });

  it('the pre-approval read is quota-limited by the approval gate capacity', async () => {
    const f = await handoffFixture();
    f.login.state.cookies = [cookie()];
    // Each pre-approval call mints a token; the gate's global capacity bounds
    // the loop (default 1000). A tight gate proves the limit engages.
    const tight = new AgentBrowserService({
      engine: new FakeEngine(),
      approvalGate: new ApprovalGate({ maxTokens: 2 }),
      loginBrowser: f.login.browser,
    });
    services.push(tight);
    const { sessionId } = await tight.createSession({ tenantId: 'owner' });
    const first = await refused(tight.handoffCookies(sessionId, { domains: ['example.com'] }));
    expect(first.code).toBe('APPROVAL_REQUIRED');
    const second = await refused(tight.handoffCookies(sessionId, { domains: ['example.com'] }));
    expect(second.code).toBe('APPROVAL_REQUIRED');
    const third = await refused(tight.handoffCookies(sessionId, { domains: ['example.com'] }));
    expect(third.code).toBe('QUOTA_EXCEEDED');
  });
});

describe('handoff input validation', () => {
  it('rejects bodies that are not the strict handoff shape', async () => {
    const engine = new FakeEngine();
    const login = fakeLoginBrowser();
    const server = await buildServer({ engine, loginBrowserPort: login.browser });
    try {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: { tenantId: 'owner' },
      });
      expect(created.statusCode).toBe(201);
      const bad = await server.inject({
        method: 'POST',
        url: `/v1/sessions/${created.json().sessionId}/cookies/handoff`,
        payload: { domains: [] },
      });
      expect(bad.statusCode).toBe(400);
      const worse = await server.inject({
        method: 'POST',
        url: `/v1/sessions/${created.json().sessionId}/cookies/handoff`,
        payload: { domains: ['example.com'], credentialSource: 'operator' },
      });
      expect(worse.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });
});
