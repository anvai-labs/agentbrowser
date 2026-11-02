import { ApprovalGate, SecretManager } from '@agentbrowser/core';
import type { EnginePage } from '@agentbrowser/engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService, type ServiceActRequest } from './service.js';

const PROBE_URL = 'https://api.vinted.test/api/items/4029603257';

const fetchRequest = (over: Record<string, unknown> = {}): ServiceActRequest => {
  // The reviewed-action canonical-JSON gate refuses explicit undefined
  // values, so an undefined override drops the key rather than nulling it.
  const request: Record<string, unknown> = {
    action: 'fetch',
    method: 'PUT',
    url: PROBE_URL,
    headers: [{ name: 'X-CSRF-Token', value: 'csrf-1' }],
    body: '{"price_cents":101}',
    ...over,
  };
  for (const key of Object.keys(request)) if (request[key] === undefined) delete request[key];
  return request as unknown as ServiceActRequest;
};

it('refuses a probe on an incapable engine', async () => {
  const service = new AgentBrowserService({ engine: new FakeEngine() });
  try {
    const { sessionId } = await service.createSession({});
    const { pageId } = await service.createPage(sessionId);
    await expect(service.act(sessionId, pageId, fetchRequest())).rejects.toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
    });
  } finally {
    await service.shutdown();
  }
});

it('denies a scope-without-PUT probe before any browser work with SCOPE_METHOD_DENIED', async () => {
  const engine = new FakeEngine();
  const caps = await engine.capabilities();
  vi.spyOn(engine, 'capabilities').mockResolvedValue({ ...caps, pageFetch: true });
  const service = new AgentBrowserService({ engine });
  try {
    const { sessionId } = await service.createSession({
      tenantId: 'owner',
      scope: { allowedHosts: ['api.vinted.test'], allowedMethods: ['GET'] },
    });
    const { pageId } = await service.createPage(sessionId);
    const page = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
    const prepareFetch = vi.fn();
    (page as EnginePage).prepareFetch = prepareFetch;
    const failure = await service.act(sessionId, pageId, fetchRequest()).catch((e) => e);
    expect(failure).toMatchObject({
      code: 'POLICY_DENIED',
      details: { scope: 'SCOPE_METHOD_DENIED' },
    });
    expect(prepareFetch).not.toHaveBeenCalled();
  } finally {
    await service.shutdown();
  }
});

it('requires one-use approval for an unsafe method even when unknown actions are allowed', async () => {
  const engine = new FakeEngine();
  const caps = await engine.capabilities();
  vi.spyOn(engine, 'capabilities').mockResolvedValue({ ...caps, pageFetch: true });
  const service = new AgentBrowserService({
    engine,
    approvalGate: new ApprovalGate(),
    approvalPolicy: { unknownRisk: 'allow' },
  });
  const dispatched = vi.fn();
  const dispose = vi.fn();
  try {
    const { sessionId } = await service.createSession({ tenantId: 'owner' });
    const { pageId } = await service.createPage(sessionId);
    const page = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
    (page as EnginePage).prepareFetch = vi.fn(async () => ({
      identity: 'document:loader:probe',
      token: {},
      dispose,
    }));
    const act = page.act.bind(page);
    vi.spyOn(page, 'act').mockImplementation(async (action) => {
      if (action.type !== 'fetch') return act(action);
      (action.fetchAssertCurrent as () => void)();
      await (action.fetchBeforeDispatch as () => Promise<void>)();
      (action.fetchAssertCurrent as () => void)();
      dispatched();
      return {
        actionId: 'probe',
        startTimestamp: new Date().toISOString(),
        endTimestamp: new Date().toISOString(),
        oldRevision: 0,
        newRevision: 0,
        result: {
          status: 200,
          headers: [],
          body: 'ok',
          bodyBytes: 2,
          truncated: false,
          outcome: 'terminal',
        },
      };
    });
    const denied = await service.act(sessionId, pageId, fetchRequest()).catch((e) => e);
    expect(denied).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(dispatched).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    const approvalToken = denied.details.tokenId;
    const receipt = await service.act(sessionId, pageId, fetchRequest({ approvalToken }));
    expect(dispatched).toHaveBeenCalledOnce();
    expect(receipt.result).toMatchObject({ status: 200 });
    // One use: the same token never dispatches a second probe.
    await expect(
      service.act(sessionId, pageId, fetchRequest({ approvalToken }))
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(dispatched).toHaveBeenCalledOnce();
  } finally {
    await service.shutdown();
  }
});

/** Prepare + dispatch stubs shared by the dispatched-probe tests. */
function stubProbePage(
  page: NonNullable<ReturnType<FakeEngine['getFakePage']>>,
  dispatched: vi.Mock,
  result: unknown = {
    status: 200,
    headers: [],
    body: 'ok',
    bodyBytes: 2,
    truncated: false,
    outcome: 'terminal',
  }
): void {
  (page as EnginePage).prepareFetch = vi.fn(async () => ({
    identity: 'document:loader:probe',
    token: {},
    dispose: () => {},
  }));
  const act = page.act.bind(page);
  vi.spyOn(page, 'act').mockImplementation(async (action) => {
    if (action.type !== 'fetch') return act(action);
    (action.fetchAssertCurrent as () => void)();
    await (action.fetchBeforeDispatch as () => Promise<void>)();
    dispatched();
    return {
      actionId: 'probe',
      startTimestamp: new Date().toISOString(),
      endTimestamp: new Date().toISOString(),
      oldRevision: 0,
      newRevision: 0,
      result,
    };
  });
}

it('allows a safe-method probe without approval and leaves the revision unchanged', async () => {
  const engine = new FakeEngine();
  const caps = await engine.capabilities();
  vi.spyOn(engine, 'capabilities').mockResolvedValue({ ...caps, pageFetch: true });
  const service = new AgentBrowserService({ engine });
  const dispatched = vi.fn();
  try {
    const { sessionId } = await service.createSession({ tenantId: 'owner' });
    const { pageId } = await service.createPage(sessionId);
    const page = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
    stubProbePage(page, dispatched);
    const first = await service.act(
      sessionId,
      pageId,
      fetchRequest({ method: 'GET', body: undefined, headers: undefined })
    );
    const second = await service.act(
      sessionId,
      pageId,
      fetchRequest({ method: 'GET', body: undefined, headers: undefined })
    );
    expect(dispatched).toHaveBeenCalledTimes(2);
    expect(first.result).toMatchObject({ status: 200 });
    // A probe never touches the document: the service revision does not move.
    expect(second.newRevision).toBe(first.newRevision);
  } finally {
    await service.shutdown();
  }
});

it('redacts registered session secrets from the probe response before publication', async () => {
  const engine = new FakeEngine();
  const caps = await engine.capabilities();
  vi.spyOn(engine, 'capabilities').mockResolvedValue({ ...caps, pageFetch: true });
  const secrets = new SecretManager();
  const service = new AgentBrowserService({ engine, secretManager: secrets });
  try {
    const { sessionId } = await service.createSession({ tenantId: 'owner' });
    secrets.registerSessionSecret(sessionId, 'csrf-secret-0123456789');
    const { pageId } = await service.createPage(sessionId);
    const page = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
    stubProbePage(page, vi.fn(), {
      status: 400,
      headers: [{ name: 'x-echo', value: 'csrf-secret-0123456789' }],
      body: 'invalid token csrf-secret-0123456789',
      bodyBytes: 32,
      truncated: false,
      outcome: 'terminal',
    });
    // GET needs no approval.
    const receipt = await service.act(
      sessionId,
      pageId,
      fetchRequest({ method: 'GET', body: undefined, headers: undefined })
    );
    const result = receipt.result as unknown as { body: string; headers: Array<{ value: string }> };
    expect(result.body).not.toContain('csrf-secret-0123456789');
    expect(result.headers[0]?.value).not.toContain('csrf-secret-0123456789');
  } finally {
    await service.shutdown();
  }
});

it('refuses a probe when the session has no scope (the engine lane is scoped-only)', async () => {
  const engine = new FakeEngine();
  const caps = await engine.capabilities();
  vi.spyOn(engine, 'capabilities').mockResolvedValue({ ...caps, pageFetch: true });
  const service = new AgentBrowserService({ engine });
  try {
    const { sessionId } = await service.createSession({ tenantId: 'owner' });
    const { pageId } = await service.createPage(sessionId);
    const page = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
    // The real engine's prepareFetch refuses without an engagement scope;
    // mirror that contract so the service path is exercised end to end.
    (page as EnginePage).prepareFetch = vi.fn(async () => {
      throw Object.assign(new Error('scoped session required'), { code: 'ENGINE_UNSUPPORTED' });
    });
    await expect(service.act(sessionId, pageId, fetchRequest())).rejects.toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
    });
  } finally {
    await service.shutdown();
  }
});
