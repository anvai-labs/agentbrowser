import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalGate } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { AgentBrowserService } from './service.js';

/**
 * TD-BROWSER-16 phase 5 (ADR-025 §5): reviewed actions and the lease in
 * `credentialSource: "operator"` sessions. The marking is server-side only —
 * no agent-facing schema accepts it; these tests reach it through the
 * service, as phase 6's handoff will.
 */

const operator = { actor: 'operator' as const, tenant: 'owner' };
const services: AgentBrowserService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
});

interface Fixture {
  service: AgentBrowserService;
  gate: ApprovalGate;
  engine: FakeEngine;
  sessionId: string;
  pageId: string;
  raw: NonNullable<ReturnType<FakeEngine['getFakePage']>>;
  dispatch: ReturnType<typeof vi.spyOn>;
  run: <T>(read: () => Promise<T>) => Promise<T>;
  binding: () => ReturnType<AgentBrowserService['authority']['reviewBindingInScope']>;
  act: (ref: string, approvalToken?: string) => Promise<unknown>;
  refOf: (name: string) => Promise<string>;
}

async function markedFixture(
  options: { allowedHosts?: string[]; delegated?: boolean; rules?: unknown[] } = {}
): Promise<Fixture> {
  const engine = new FakeEngine();
  const gate = new ApprovalGate();
  const service = new AgentBrowserService({
    engine,
    approvalGate: gate,
    ...(options.rules ? { approvalPolicy: { rules: options.rules } } : {}),
  });
  services.push(service);
  const { sessionId } = await service.createSession({
    tenantId: 'owner',
    credentialSource: 'operator',
    ...(options.delegated === false ? {} : { controlMode: 'delegated' as const }),
    ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
  });
  // Delegated sessions must run under the operator's authority; wrapping a
  // plain session would leave a stale control context that breaks later calls.
  const run =
    options.delegated === false
      ? <T>(read: () => Promise<T>): Promise<T> => read()
      : <T>(read: () => Promise<T>): Promise<T> =>
          service.authority.run(sessionId, operator, {}, read) as Promise<T>;
  const { pageId } = await run(() => service.createPage(sessionId));
  const raw = engine.getFakePage(engine.getSessionIds()[0] ?? '', pageId);
  if (!raw) throw new Error('Expected an engine page');
  await raw.navigate({ url: 'https://example.com/start' });
  const refOf = async (name: string): Promise<string> => {
    const view = (await run(() => service.observe(sessionId, pageId, {}))) as {
      elements?: Array<{ ref: string; name?: string }>;
    };
    const element = view.elements?.find((candidate) => candidate.name === name);
    if (!element) throw new Error(`No element named ${name}`);
    return element.ref;
  };
  const act = (ref: string, approvalToken?: string) =>
    run(() =>
      service.act(sessionId, pageId, {
        action: 'click',
        target: { ref },
        ...(approvalToken !== undefined ? { approvalToken } : {}),
      })
    );
  return {
    service,
    gate,
    engine,
    sessionId,
    pageId,
    raw,
    dispatch: vi.spyOn(raw, 'act'),
    run,
    binding: () => service.authority.reviewBindingInScope(sessionId),
    act,
    refOf,
  };
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

describe('marked sessions: reviewed actions (ADR-025 s5)', () => {
  it('a transaction action needs an operator decision; a pending-token retry is refused, an approved one runs once', async () => {
    const f = await markedFixture();
    f.raw.setElements([{ role: 'button', name: 'Pay now', risk: 'transaction' }]);
    const ref = await f.refOf('Pay now');
    const refusal = await refused(f.act(ref));
    expect(refusal.code).toBe('APPROVAL_REQUIRED');
    expect(refusal.details).toMatchObject({ effect: 'transaction', review: 'operator' });
    const tokenId = (refusal.details as { tokenId: string }).tokenId;
    // The agent retrying with the still-pending token id: refused again —
    // the token is not a bypass, only the operator's decision arms it.
    const retry = await refused(f.act(ref, tokenId));
    expect(retry.code).toBe('APPROVAL_REQUIRED');
    // The operator approves; the same retry runs the action exactly once.
    // (The review binding is only visible inside an admitted authority scope.)
    await f.run(() => f.gate.decideReviewedApproval(tokenId, f.binding(), 'approve'));
    await f.act(ref, tokenId);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    // Burned: after the dispatch the ref is stale (as for any act); the next
    // attempt — with a fresh ref, the used token — needs a fresh decision.
    const after = await refused(f.act(await f.refOf('Pay now'), tokenId));
    expect(after.code).toBe('APPROVAL_REQUIRED');
  });

  it('an unknown-effect action needs a decision too', async () => {
    const f = await markedFixture();
    f.raw.setElements([{ role: 'button', name: 'Mystery control' }]);
    const refusal = await refused(f.act(await f.refOf('Mystery control')));
    expect(refusal.code).toBe('APPROVAL_REQUIRED');
    expect(refusal.details).toMatchObject({ effect: 'unknown', review: 'operator' });
  });

  it('a per-rule allow on a high-risk effect is overridden by the marking', async () => {
    const rule = {
      hostname: 'example.com',
      action: 'click',
      effect: 'transaction',
      decision: 'allow',
    };
    // Control: without the marking the same rule lets the click run.
    const engine = new FakeEngine();
    const plain = new AgentBrowserService({ engine, approvalPolicy: { rules: [rule] } });
    services.push(plain);
    const session = await plain.createSession({ tenantId: 'owner' });
    const page = await plain.createPage(session.sessionId);
    const raw = engine.getFakePage(engine.getSessionIds()[0] ?? '', page.pageId);
    if (!raw) throw new Error('Expected an engine page');
    await raw.navigate({ url: 'https://example.com/start' });
    raw.setElements([{ role: 'button', name: 'Pay now', risk: 'transaction' }]);
    const view = (await plain.observe(session.sessionId, page.pageId, {})) as {
      elements?: Array<{ ref: string; name?: string }>;
    };
    const ref = view.elements?.find((candidate) => candidate.name === 'Pay now')?.ref;
    if (!ref) throw new Error('Expected the pay button');
    const dispatch = vi.spyOn(raw, 'act');
    await plain.act(session.sessionId, page.pageId, { action: 'click', target: { ref } });
    expect(dispatch).toHaveBeenCalledTimes(1);
    // Marked: the rule's allow is overridden — the decision is still required.
    const f = await markedFixture({ rules: [rule] });
    f.raw.setElements([{ role: 'button', name: 'Pay now', risk: 'transaction' }]);
    const refusal = await refused(f.act(await f.refOf('Pay now')));
    expect(refusal.code).toBe('APPROVAL_REQUIRED');
    expect(refusal.details).toMatchObject({ effect: 'transaction' });
  });

  it('read-classified actions are honoured unchanged (no review, no lease)', async () => {
    const f = await markedFixture();
    // hover is a read action even over a transaction-classified element
    f.raw.setElements([{ role: 'button', name: 'Pay now', risk: 'transaction' }]);
    const ref = await f.refOf('Pay now');
    await f.run(() => f.service.act(f.sessionId, f.pageId, { action: 'hover', target: { ref } }));
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('marked sessions: the lease (ADR-025 s5)', () => {
  it('admits unknown actions on its hosts only, never high-risk ones, and stops at its count and expiry', async () => {
    const f = await markedFixture({ allowedHosts: ['example.com', 'other.org'] });
    await f.service.grantActionLease(f.sessionId, {
      hosts: ['example.com'],
      expiresInMs: 60_000,
      maxActions: 2,
    });
    // Unknown on a covered host: runs, one count spent.
    f.raw.setElements([{ role: 'button', name: 'Routine one' }]);
    await f.act(await f.refOf('Routine one'));
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.service.getSession(f.sessionId)?.actionLease).toMatchObject({
      remainingActions: 1,
      maxActions: 2,
    });
    // High-risk on the SAME covered host: the lease never admits it.
    f.raw.setElements([
      { role: 'button', name: 'Routine two' },
      { role: 'button', name: 'Pay now', risk: 'transaction' },
    ]);
    const highRisk = await refused(f.act(await f.refOf('Pay now')));
    expect(highRisk.code).toBe('APPROVAL_REQUIRED');
    expect(highRisk.details).toMatchObject({ effect: 'transaction' });
    // Unknown on a host the lease does not cover: review, not the lease.
    await f.raw.navigate({ url: 'https://other.org/form' });
    f.raw.setElements([{ role: 'button', name: 'Elsewhere' }]);
    const elsewhere = await refused(f.act(await f.refOf('Elsewhere')));
    expect(elsewhere.code).toBe('APPROVAL_REQUIRED');
    expect(elsewhere.details).toMatchObject({ effect: 'unknown' });
    // Back on the covered host: the second (last) count spends, the third needs review.
    await f.raw.navigate({ url: 'https://example.com/form' });
    f.raw.setElements([{ role: 'button', name: 'Routine three' }]);
    await f.act(await f.refOf('Routine three'));
    const spent = await refused(f.act(await f.refOf('Routine three')));
    expect(spent.code).toBe('APPROVAL_REQUIRED');
    expect(spent.details).toMatchObject({ effect: 'unknown' });
  });

  it('an expired lease no longer admits anything', async () => {
    const f = await markedFixture({ allowedHosts: ['example.com'] });
    await f.service.grantActionLease(f.sessionId, {
      hosts: ['example.com'],
      expiresInMs: 1,
      maxActions: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    f.raw.setElements([{ role: 'button', name: 'Too late' }]);
    const refusal = await refused(f.act(await f.refOf('Too late')));
    expect(refusal.code).toBe('APPROVAL_REQUIRED');
    expect(refusal.details).toMatchObject({ effect: 'unknown' });
  });

  it('a policy deny stands above the lease, even for a covered unknown action (review F3)', async () => {
    // Deny only the act questions; everything else stays allowed so the
    // fixture's session and page lifecycle behave normally.
    const denyActs = {
      version: 'test-deny-acts',
      decide: (request: { action: string }) =>
        request.action === 'act'
          ? { allowed: false, reason: 'test deny', rulesMatched: [] }
          : { allowed: true, reason: 'test allow', rulesMatched: [] },
    };
    const engine = new FakeEngine();
    const service = new AgentBrowserService({ engine, authorizer: denyActs });
    services.push(service);
    const { sessionId } = await service.createSession({
      tenantId: 'owner',
      credentialSource: 'operator',
      controlMode: 'delegated',
      allowedHosts: ['example.com'],
    });
    const run = <T>(read: () => Promise<T>): Promise<T> =>
      service.authority.run(sessionId, operator, {}, read) as Promise<T>;
    const { pageId } = await run(() => service.createPage(sessionId));
    const raw = engine.getFakePage(engine.getSessionIds()[0] ?? '', pageId);
    if (!raw) throw new Error('Expected an engine page');
    await raw.navigate({ url: 'https://example.com/start' });
    raw.setElements([{ role: 'button', name: 'Denied routine' }]);
    // A live lease covers the host — the deny must still win.
    await service.grantActionLease(sessionId, {
      hosts: ['example.com'],
      expiresInMs: 60_000,
      maxActions: 5,
    });
    const view = (await run(() => service.observe(sessionId, pageId, {}))) as {
      elements?: Array<{ ref: string }>;
    };
    const ref = view.elements?.[0]?.ref;
    if (!ref) throw new Error('Expected the button');
    const refusal = await refused(
      run(() => service.act(sessionId, pageId, { action: 'click', target: { ref } }))
    );
    expect(refusal.code).toBe('POLICY_DENIED');
    expect(refusal.details).toMatchObject({ effect: 'unknown' });
  });

  it('grant validation: usable hosts within the session allowlist, and the bounds', async () => {
    const f = await markedFixture({ allowedHosts: ['example.com'] });
    await expect(
      f.service.grantActionLease(f.sessionId, {
        hosts: ['other.org'],
        expiresInMs: 1000,
        maxActions: 1,
      })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      f.service.grantActionLease(f.sessionId, { hosts: ['com'], expiresInMs: 1000, maxActions: 1 })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); // a bare suffix is not a usable host
    await expect(
      f.service.grantActionLease(f.sessionId, {
        hosts: ['example.com'],
        expiresInMs: 4 * 60 * 60 * 1000 + 1,
        maxActions: 1,
      })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      f.service.grantActionLease(f.sessionId, {
        hosts: ['example.com'],
        expiresInMs: 1000,
        maxActions: 501,
      })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    // A session with no allowlist has nothing for a lease to lie within.
    const bare = await markedFixture();
    await expect(
      bare.service.grantActionLease(bare.sessionId, {
        hosts: ['example.com'],
        expiresInMs: 1000,
        maxActions: 1,
      })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    // An unmarked session never accepts a lease at all.
    const engine = new FakeEngine();
    const plain = new AgentBrowserService({ engine });
    services.push(plain);
    const session = await plain.createSession({ tenantId: 'owner', allowedHosts: ['example.com'] });
    await expect(
      plain.grantActionLease(session.sessionId, {
        hosts: ['example.com'],
        expiresInMs: 1000,
        maxActions: 1,
      })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('marked sessions: write paths outside act (ADR-025 s5)', () => {
  it('autofill is refused without a lease and each field write spends one leased action', async () => {
    const f = await markedFixture({ delegated: false, allowedHosts: ['example.com'] });
    f.raw.seedElements([
      {
        ref: 'company',
        role: 'textbox',
        name: 'Company',
        attributes: {
          tag: 'input',
          type: 'text',
          'autofill-node': 'company',
          'autofill-block': '',
        },
      },
    ]);
    const request = {
      fields: [
        { match: { label: 'Company' }, value: 'Anvai Labs' },
        { match: { label: 'Company' }, value: 'Anvai Labs' },
      ],
      policy: { settleMs: 0 },
    } as unknown as Parameters<AgentBrowserService['autofill']>[2];
    const denied = await refused(f.service.autofill(f.sessionId, f.pageId, request));
    expect(denied.code).toBe('POLICY_DENIED');
    await f.service.grantActionLease(f.sessionId, {
      hosts: ['example.com'],
      expiresInMs: 60_000,
      maxActions: 10,
    });
    const report = (await f.service.autofill(f.sessionId, f.pageId, request)) as {
      receipts: unknown[];
    };
    expect(report.receipts.length).toBe(2);
    expect(f.service.getSession(f.sessionId)?.actionLease).toMatchObject({ remainingActions: 8 });
  });

  it('application.execute is refused outright', async () => {
    const f = await markedFixture({ delegated: false });
    const refusal = await refused(
      f.service.applicationExecute(f.sessionId, operator, { operation: 'noop', input: {} })
    );
    expect(refusal.code).toBe('POLICY_DENIED');
  });
});

describe('the lease over HTTP (TD-BROWSER-16 phase 5)', () => {
  const operatorKey = 'operator-key-fixture-0001';
  let keysDir: string | undefined;
  afterEach(async () => {
    if (keysDir !== undefined) await rm(keysDir, { recursive: true, force: true });
    keysDir = undefined;
    delete process.env.AGENTBROWSER_OPERATOR_KEYS_FILE;
    delete process.env.AGENTBROWSER_API_KEYS;
  });

  async function operatorServer() {
    keysDir = await mkdtemp(join(tmpdir(), 'lease-keys-'));
    const file = join(keysDir, 'operator.keys');
    await writeFile(file, `${operatorKey}:owner\n`, 'utf8');
    process.env.AGENTBROWSER_OPERATOR_KEYS_FILE = file;
    process.env.AGENTBROWSER_API_KEYS = 'api-key-aaaaaaaaaaaa:owner';
    return buildServer({ engine: new FakeEngine() });
  }

  it('grants for the human operator only; an agent-shaped caller is refused; the view shows the remainder', async () => {
    const server = await operatorServer();
    try {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: { authorization: 'Bearer api-key-aaaaaaaaaaaa' },
        payload: { tenantId: 'owner', policy: { allowedHosts: ['example.com'] } },
      });
      expect(created.statusCode).toBe(201);
      const sessionId = created.json().sessionId as string;
      // The marking is server-side only: reach it through the service, as
      // phase 6's handoff will.
      (server as unknown as { service: AgentBrowserService }).service.markOperatorCredentialSource(
        sessionId
      );
      const url = `/v1/sessions/${sessionId}/lease`;
      // An API-key operator (which an agent may hold) cannot grant a lease.
      const api = await server.inject({
        method: 'POST',
        url,
        headers: { authorization: 'Bearer api-key-aaaaaaaaaaaa' },
        payload: { hosts: ['example.com'], expiresInMs: 1000, maxActions: 5 },
      });
      expect(api.statusCode).toBe(403);
      // FLOOR_OPERATOR_REQUIRED carries the wire code FORBIDDEN (floor.ts).
      expect(api.json().error.code).toBe('FORBIDDEN');
      // An unauthenticated caller cannot either.
      const anon = await server.inject({
        method: 'POST',
        url,
        payload: { hosts: ['example.com'], expiresInMs: 1000, maxActions: 5 },
      });
      expect(anon.statusCode).toBe(401);
      // The human operator can; the session then shows the remainder.
      const grant = await server.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${operatorKey}` },
        payload: { hosts: ['example.com'], expiresInMs: 1000, maxActions: 5 },
      });
      expect(grant.statusCode).toBe(201);
      expect(grant.json()).toMatchObject({ hosts: ['example.com'], remainingActions: 5 });
      const view = await server.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionId}`,
        headers: { authorization: 'Bearer api-key-aaaaaaaaaaaa' },
      });
      expect(view.json().actionLease).toMatchObject({ remainingActions: 5, maxActions: 5 });
      expect(view.json().actionLeaseRemainingMs).toBeGreaterThan(0);
      // A host outside the session allowlist is refused.
      const outside = await server.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${operatorKey}` },
        payload: { hosts: ['other.org'], expiresInMs: 1000, maxActions: 5 },
      });
      expect(outside.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('an agent cannot mark its own session: credentialSource in the create body is refused by name (review F1)', async () => {
    const server = await operatorServer();
    try {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: { authorization: 'Bearer api-key-aaaaaaaaaaaa' },
        payload: {
          tenantId: 'owner',
          // The wire passes unknown keys through — this one must be refused
          // BY NAME, or the agent forges the trust indicator phase 6 builds on.
          credentialSource: 'operator',
          policy: { allowedHosts: ['example.com'] },
        },
      });
      expect(created.statusCode).toBe(400);
      expect(created.json().error.code).toBe('INVALID_REQUEST');
    } finally {
      await server.close();
    }
  });

  it('lease-shaped input on an agent route is inert: nothing is granted', async () => {
    const server = await operatorServer();
    try {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: { authorization: 'Bearer api-key-aaaaaaaaaaaa' },
        payload: {
          tenantId: 'owner',
          // The wire passes unknown keys through, but nothing parses them:
          // the proof is the view — no lease exists on the session.
          lease: { hosts: ['example.com'], expiresInMs: 1000, maxActions: 5 },
          policy: { allowedHosts: ['example.com'], lease: { maxActions: 5 } },
        },
      });
      expect(created.statusCode).toBe(201);
      const sessionId = created.json().sessionId as string;
      const view = await server.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionId}`,
        headers: { authorization: 'Bearer api-key-aaaaaaaaaaaa' },
      });
      expect(view.json().actionLease).toBeUndefined();
      expect(view.json().actionLeaseRemainingMs).toBeUndefined();
      expect(view.json().credentialSource).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('the marked-session write-path checklist: every page-writing route declares its behaviour', async () => {
    const server = await buildServer({ engine: new FakeEngine() });
    try {
      // Declared marked-session behaviour for every route that can write to
      // a page. A future write path fails here until it declares one.
      const declared: Record<string, string> = {
        'POST /v1/sessions/:sessionId/pages/:pageId/act':
          'high-risk and unknown need act.reviewed; a live lease admits unknown on its hosts',
        'POST /v1/sessions/:sessionId/pages/:pageId/plan':
          'plans dispatch through the same per-action approval path as act',
        'POST /v1/sessions/:sessionId/pages/:pageId/autofill':
          'refused without a covering lease; each field write spends one leased unknown action',
        'POST /v1/sessions/:sessionId/application/execute': 'refused outright in a marked session',
        'POST /v1/sessions/:sessionId/pages/:pageId/navigate':
          'not restricted by phase 5; bounded by the session host policy',
        'POST /v1/sessions/:sessionId/pages/:pageId/download':
          'not restricted by phase 5; downloads need their own session opt-in',
      };
      // Mutating routes that do not write page content.
      const notPageWrites = new Set([
        'POST /v1/sessions',
        'POST /v1/sessions/:sessionId/pages',
        'POST /v1/sessions/:sessionId/pages/:pageId/observe',
        'POST /v1/sessions/:sessionId/pages/:pageId/extract',
        'POST /v1/sessions/:sessionId/pages/:pageId/html',
        'POST /v1/sessions/:sessionId/pages/:pageId/pdf',
        'POST /v1/sessions/:sessionId/pages/:pageId/screenshot',
        'POST /v1/sessions/:sessionId/pages/:pageId/outcomes',
        'POST /v1/sessions/:sessionId/pages/:pageId/downloads/:filename',
        'POST /v1/sessions/:sessionId/trace',
        'POST /v1/sessions/:sessionId/approvals/:tokenId',
        'POST /v1/sessions/:sessionId/lease',
        'POST /v1/sessions/:sessionId/control/delegate',
        'POST /v1/sessions/:sessionId/control/prepare-resume',
        'POST /v1/sessions/:sessionId/control/takeover',
        'POST /v1/sessions/:sessionId/application/reviews',
        'PUT /v1/sessions/:sessionId/application',
        'DELETE /v1/sessions/:sessionId',
        'DELETE /v1/sessions/:sessionId/application',
        'DELETE /v1/sessions/:sessionId/pages/:pageId',
        'POST /v1/operator/login/open',
        'POST /v1/operator/login/close',
        'POST /v1/operator/login/reset',
        'POST /v1/operator/login/read',
        'POST /v1/policy/check',
      ]);
      const routes = (server.registeredRoutes as Array<{ method: string; url: string }>)
        .map((route) => `${route.method} ${route.url}`)
        .filter(
          (key) =>
            !key.startsWith('GET ') && !key.startsWith('HEAD ') && !key.startsWith('OPTIONS ')
        );
      expect(routes.length).toBeGreaterThan(10);
      const undeclared = routes.filter((key) => !declared[key] && !notPageWrites.has(key));
      expect(undeclared).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
