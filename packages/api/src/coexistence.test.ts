import { createHash } from 'node:crypto';
import { setImmediate as settlePublication } from 'node:timers/promises';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

const operator = { authorization: 'Bearer operator' };
const keys = new Map([[createHash('sha256').update('operator').digest('hex'), 'owner']]);
const servers: Awaited<ReturnType<typeof buildServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function setup() {
  const engine = new FakeEngine();
  const server = await buildServer({ engine, apiKeys: keys });
  servers.push(server);
  const created = await server.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: operator,
    payload: { controlMode: 'delegated' },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().sessionId;
  const url = `/v1/sessions/${id}`;
  return { server, engine, id, url };
}

function requireFakePage(engine: FakeEngine, pageId: string) {
  const sessionId = engine.getSessionIds()[0];
  if (!sessionId) throw new Error('Expected one engine session');
  const page = engine.getFakePage(sessionId, pageId);
  if (!page) throw new Error('Expected an engine page');
  return page;
}

async function delegate(
  server: Awaited<ReturnType<typeof buildServer>>,
  url: string,
  mode?: string
) {
  // inject resolves at response finish before publication's release continuation.
  await settlePublication();
  const review = await server.inject({
    method: 'POST',
    url: `${url}/control/prepare-resume`,
    headers: operator,
  });
  expect(review.statusCode).toBe(200);
  await settlePublication();
  const granted = await server.inject({
    method: 'POST',
    url: `${url}/control/delegate`,
    headers: operator,
    payload: { epoch: review.json().epoch, ...(mode ? { mode } : {}) },
  });
  expect(granted.statusCode).toBe(200);
  expect(granted.json().mode).toBe(mode ?? 'qa');
  expect(granted.json().cursor).toMatchObject({
    version: 1,
    sessionId: url.split('/').at(-1),
    controlEpoch: granted.json().epoch,
    mode: mode ?? 'qa',
    profileRevision: 1,
  });
  expect(JSON.stringify(granted.json().cursor)).not.toContain(granted.json().token);
  await settlePublication();
  return { authorization: `Bearer ${granted.json().token}` };
}

describe('delegated coexistence', () => {
  it('binds a mode to the grant and rejects disallowed direct API calls before dispatch', async () => {
    const { server, url } = await setup();
    const created = await server.inject({
      method: 'POST',
      url: `${url}/pages`,
      headers: { ...operator, 'x-agentbrowser-operation-id': 'operator-page' },
    });
    expect(created.statusCode).toBe(201);
    const pageId = created.json().pageId;
    const agent = await delegate(server, url, 'audit');

    expect((await server.inject({ url: `${url}/pages`, headers: agent })).statusCode).toBe(200);
    const denied = await server.inject({
      method: 'POST',
      url: `${url}/pages/${pageId}/autofill`,
      headers: { ...agent, 'x-agentbrowser-operation-id': 'hidden-direct-call' },
      payload: { fields: [{ match: { label: 'Name' }, value: 'private' }] },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toContain('profile');

    await server.inject({ method: 'POST', url: `${url}/control/takeover`, headers: operator });
    const operatorCall = await server.inject({
      method: 'POST',
      url: `${url}/pages/${pageId}/autofill`,
      headers: { ...operator, 'x-agentbrowser-operation-id': 'operator-autofill' },
      payload: { fields: [{ match: { label: 'Name' }, value: 'private' }] },
    });
    expect(operatorCall.statusCode).not.toBe(403);
  });

  it('rejects unknown modes without minting a bearer grant', async () => {
    const { server, url } = await setup();
    const review = await server.inject({
      method: 'POST',
      url: `${url}/control/prepare-resume`,
      headers: operator,
    });
    const denied = await server.inject({
      method: 'POST',
      url: `${url}/control/delegate`,
      headers: operator,
      payload: { epoch: review.json().epoch, mode: 'admin' },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.body).not.toContain('token');
    expect((await server.inject({ url: `${url}/control`, headers: operator })).json().state).toBe(
      'RESUME_REVIEW'
    );
  });

  it('requires operator authentication for controlled mode even in local no-key deployments', async () => {
    const server = await buildServer({ engine: new FakeEngine() });
    servers.push(server);
    const result = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { tenantId: 'owner', controlMode: 'delegated' },
    });
    expect(result.statusCode).toBe(403);
  });

  it('delegates one session, revokes it on takeover, and requires new authority on resume', async () => {
    const { server, url } = await setup();
    const agent = await delegate(server, url);
    expect((await server.inject({ url: `${url}/control`, headers: agent })).json().state).toBe(
      'AGENT_ACTIVE'
    );
    for (const target of ['/v1/sessions', `${url}/cookies`, `${url}/events/replay`]) {
      expect((await server.inject({ url: target, headers: agent })).statusCode).toBe(403);
    }
    expect(
      (await server.inject({ method: 'POST', url: `${url}/control/takeover`, headers: agent }))
        .statusCode
    ).toBe(403);
    expect(
      (
        await server.inject({ method: 'POST', url: `${url}/control/takeover`, headers: operator })
      ).json().state
    ).toBe('HUMAN_ACTIVE');
    expect((await server.inject({ url, headers: agent })).statusCode).toBe(401);
    const next = await delegate(server, url);
    expect(next.authorization).not.toBe(agent.authorization);
    expect((await server.inject({ url, headers: next })).statusCode).toBe(200);
    expect((await server.inject({ url, headers: agent })).statusCode).toBe(401);
  });

  it('requires an operation ID and never repeats an already recorded page creation', async () => {
    const { server, url } = await setup();
    const agent = await delegate(server, url);
    expect(
      (await server.inject({ method: 'POST', url: `${url}/pages`, headers: agent })).statusCode
    ).toBe(400);
    const headers = { ...agent, 'x-agentbrowser-operation-id': 'create-page-1' };
    const first = await server.inject({ method: 'POST', url: `${url}/pages`, headers });
    expect(first.statusCode).toBe(201);
    const replay = await server.inject({ method: 'POST', url: `${url}/pages`, headers });
    expect(replay.json()).toMatchObject({ replay: true, operation: { status: 'completed' } });
    const pages = await server.inject({ url: `${url}/pages`, headers: agent });
    expect(pages.json().pages).toHaveLength(1);
  });

  it('blocks old artifact access after takeover and across subsequent grants', async () => {
    const { server, url } = await setup();
    const privatePage = await server.inject({
      method: 'POST',
      url: `${url}/pages`,
      headers: { ...operator, 'x-agentbrowser-operation-id': 'owner-page' },
    });
    const pageId = privatePage.json().pageId;
    await settlePublication();
    const capture = await server.inject({
      method: 'POST',
      url: `${url}/pages/${pageId}/screenshot`,
      headers: operator,
    });
    expect(capture.statusCode).toBe(200);
    const agent = await delegate(server, url);
    const artifact = capture.json().artifactId;
    expect(
      (
        await server.inject({
          url: `${url}/artifacts/${artifact}?token=irrelevant`,
          headers: agent,
        })
      ).statusCode
    ).toBe(403);
  });
  it('revokes pending evidence and holds HUMAN_ACTIVE until browser work settles', async () => {
    const { server, engine, url } = await setup();
    const created = await server.inject({
      method: 'POST',
      url: `${url}/pages`,
      headers: { ...operator, 'x-agentbrowser-operation-id': 'page' },
    });
    const pageId = created.json().pageId;
    const raw = requireFakePage(engine, pageId);
    const screenshot = raw.screenshot.bind(raw);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(raw, 'screenshot').mockImplementation(async (request) => {
      entered.resolve();
      await release.promise;
      return screenshot(request);
    });
    const agent = await delegate(server, url);
    const pending = server
      .inject({ method: 'POST', url: `${url}/pages/${pageId}/screenshot`, headers: agent })
      .then((r) => r);
    await entered.promise;
    expect((await server.inject({ url: `${url}/pages`, headers: agent })).json().error.code).toBe(
      'SESSION_BUSY'
    );
    expect(
      (
        await server.inject({ method: 'POST', url: `${url}/control/takeover`, headers: operator })
      ).json().state
    ).toBe('PAUSE_REQUESTED');
    expect(
      (
        await server.inject({
          method: 'POST',
          url: `${url}/control/prepare-resume`,
          headers: operator,
        })
      ).statusCode
    ).toBe(409);
    release.resolve();
    const result = await pending;
    expect(result.statusCode).toBe(409);
    expect(result.body).not.toContain('contentBase64');
    expect((await server.inject({ url: `${url}/control`, headers: operator })).json().state).toBe(
      'HUMAN_ACTIVE'
    );
  });

  it('cannot delegate a review whose fresh observation failed', async () => {
    const { server, engine, url } = await setup();
    const created = await server.inject({
      method: 'POST',
      url: `${url}/pages`,
      headers: { ...operator, 'x-agentbrowser-operation-id': 'page' },
    });
    const raw = requireFakePage(engine, created.json().pageId);
    vi.spyOn(raw, 'observe').mockRejectedValueOnce(new Error('Observation failed'));
    const review = await server.inject({
      method: 'POST',
      url: `${url}/control/prepare-resume`,
      headers: operator,
    });
    expect(review.statusCode).toBeGreaterThanOrEqual(400);
    const state = (await server.inject({ url: `${url}/control`, headers: operator })).json();
    expect(state.state).toBe('HUMAN_ACTIVE');
    expect(
      (
        await server.inject({
          method: 'POST',
          url: `${url}/control/delegate`,
          headers: operator,
          payload: { epoch: state.epoch },
        })
      ).statusCode
    ).toBe(409);
  });

  it('withholds a pending page title after takeover and drains the admitted read', async () => {
    const { server, engine, url } = await setup();
    const created = await server.inject({
      method: 'POST',
      url: `${url}/pages`,
      headers: { ...operator, 'x-agentbrowser-operation-id': 'metadata-page' },
    });
    const pageId = created.json().pageId;
    const raw = requireFakePage(engine, pageId);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(raw, 'getTitle').mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return 'private-after-takeover';
    });
    const agent = await delegate(server, url);
    const pending = server.inject({ url: `${url}/pages/${pageId}`, headers: agent }).then((r) => r);
    try {
      await entered.promise;
      expect(
        (
          await server.inject({
            method: 'POST',
            url: `${url}/control/takeover`,
            headers: operator,
          })
        ).json().state
      ).toBe('PAUSE_REQUESTED');
    } finally {
      release.resolve();
    }
    const result = await pending;
    expect(result.statusCode).toBe(409);
    expect(result.body).not.toContain('private-after-takeover');
    expect(
      (await server.inject({ url: `${url}/control`, headers: operator })).json()
    ).toMatchObject({
      state: 'HUMAN_ACTIVE',
      busy: false,
    });
  });
  it('stops the remaining plan steps on takeover and records dispatched uncertainty', async () => {
    const { server, engine, url } = await setup();
    const created = await server.inject({
      method: 'POST',
      url: `${url}/pages`,
      headers: { ...operator, 'x-agentbrowser-operation-id': 'page' },
    });
    const pageId = created.json().pageId;
    const raw = requireFakePage(engine, pageId);
    const act = raw.act.bind(raw);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls = vi.spyOn(raw, 'act').mockImplementation(async (action) => {
      entered.resolve();
      await release.promise;
      return act(action);
    });
    const agent = await delegate(server, url);
    const pending = server
      .inject({
        method: 'POST',
        url: `${url}/pages/${pageId}/plan`,
        headers: { ...agent, 'x-agentbrowser-operation-id': 'plan-1' },
        payload: {
          actions: [
            { action: 'press', key: 'Tab' },
            { action: 'press', key: 'Tab' },
          ],
        },
      })
      .then((r) => r);
    await entered.promise;
    expect(
      (
        await server.inject({ method: 'POST', url: `${url}/control/takeover`, headers: operator })
      ).json().state
    ).toBe('PAUSE_REQUESTED');
    release.resolve();
    expect((await pending).statusCode).toBe(409);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(
      (await server.inject({ url: `${url}/operations/plan-1`, headers: operator })).json()
    ).toMatchObject({ status: 'outcome_unknown', dispatched: true });
    expect(
      (await server.inject({ url: `${url}/control`, headers: operator })).json()
    ).toMatchObject({ state: 'HUMAN_ACTIVE', busy: false });
  });

  it.each([
    { surface: 'plan', path: 'plan', field: 'actions' },
    { surface: 'batch action', path: 'act', field: 'steps' },
  ])('records a partially applied $surface report as uncertain', async ({ path, field }) => {
    const { server, engine, url } = await setup();
    const created = await server.inject({
      method: 'POST',
      url: `${url}/pages`,
      headers: { ...operator, 'x-agentbrowser-operation-id': `${path}-page` },
    });
    const pageId = created.json().pageId;
    const raw = requireFakePage(engine, pageId);
    raw.seedElements([{ ref: 'submit', role: 'button', name: 'Submit' }]);
    const observed = await server.inject({
      method: 'POST',
      url: `${url}/pages/${pageId}/observe`,
      headers: operator,
      payload: { mode: 'interactive' },
    });
    const ref = observed.json().elements[0]?.ref;
    if (!ref) throw new Error('Expected one observed element');
    const act = raw.act.bind(raw);
    const resolutions = vi.spyOn(raw, 'resolve');
    const writes = vi.spyOn(raw, 'act').mockImplementationOnce(async (action) => {
      const effect = await act(action);
      resolutions.mockRejectedValue(new Error('target replaced after first action'));
      return effect;
    });
    const agent = await delegate(server, url);
    const request = {
      method: 'POST' as const,
      url: `${url}/pages/${pageId}/${path}`,
      headers: { ...agent, 'x-agentbrowser-operation-id': `${path}-partial` },
      payload: {
        [field]: [
          { action: 'click', target: { ref } },
          { action: 'click', target: { ref } },
        ],
      },
    };

    const report = await server.inject(request);
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject(
      path === 'plan' ? { ok: false, completed: 1 } : { status: 'failed', completed: 1 }
    );
    expect(writes).toHaveBeenCalledOnce();
    expect(
      (await server.inject({ url: `${url}/operations/${path}-partial`, headers: agent })).json()
    ).toMatchObject({ status: 'outcome_unknown', dispatched: true });
    expect((await server.inject(request)).json()).toMatchObject({
      replay: true,
      operation: { status: 'outcome_unknown', dispatched: true },
    });
    expect(writes).toHaveBeenCalledOnce();

    const success = await server.inject({
      ...request,
      headers: { ...agent, 'x-agentbrowser-operation-id': `${path}-success` },
      payload: { [field]: [{ action: 'press', key: 'Tab' }] },
    });
    expect(success.statusCode).toBe(200);
    expect(success.json()).toMatchObject(path === 'plan' ? { ok: true } : { status: 'success' });
    expect(
      (await server.inject({ url: `${url}/operations/${path}-success`, headers: agent })).json()
    ).toMatchObject({ status: 'completed', dispatched: true });
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it('records an in-band plan refusal before dispatch as failed', async () => {
    const { server, engine, url } = await setup();
    const created = await server.inject({
      method: 'POST',
      url: `${url}/pages`,
      headers: { ...operator, 'x-agentbrowser-operation-id': 'wait-page' },
    });
    const pageId = created.json().pageId;
    const raw = requireFakePage(engine, pageId);
    const writes = vi.spyOn(raw, 'act');
    const agent = await delegate(server, url);
    const request = {
      method: 'POST' as const,
      url: `${url}/pages/${pageId}/plan`,
      headers: { ...agent, 'x-agentbrowser-operation-id': 'wait-refusal' },
      payload: {
        actions: [{ action: 'click', target: { ref: 'e0_0' } }],
      },
    };

    const report = await server.inject(request);
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({ ok: false, completed: 0 });
    expect(writes).not.toHaveBeenCalled();
    expect(
      (await server.inject({ url: `${url}/operations/wait-refusal`, headers: agent })).json()
    ).toMatchObject({ status: 'failed', dispatched: false });
    expect((await server.inject(request)).json()).toMatchObject({
      replay: true,
      operation: { status: 'failed', dispatched: false },
    });
  });
});

it('records a partially applied autofill as uncertain and refuses replay of the batch', async () => {
  const { server, engine, url } = await setup();
  const created = await server.inject({
    method: 'POST',
    url: `${url}/pages`,
    headers: { ...operator, 'x-agentbrowser-operation-id': 'page' },
  });
  const pageId = created.json().pageId;
  const raw = requireFakePage(engine, pageId);
  raw.seedElements([
    {
      ref: 'company',
      role: 'textbox',
      name: 'Company',
      attributes: { tag: 'input', type: 'text', 'autofill-node': 'company', 'autofill-block': '' },
    },
  ]);
  const writes = vi.spyOn(raw, 'act');
  const agent = await delegate(server, url);
  const request = {
    method: 'POST' as const,
    url: `${url}/pages/${pageId}/autofill`,
    headers: { ...agent, 'x-agentbrowser-operation-id': 'bulk-partial' },
    payload: {
      fields: [
        { match: { label: 'Company' }, value: 'Example' },
        { match: { label: 'Missing' }, value: 'Untouched' },
      ],
      policy: { settleMs: 0, maxReobserve: 0 },
    },
  };
  const report = await server.inject(request);
  expect(report.statusCode).toBe(200);
  expect(report.json()).toMatchObject({
    ok: false,
    receipts: [{ status: 'verified' }, { status: 'failed' }],
  });
  const operation = await server.inject({ url: `${url}/operations/bulk-partial`, headers: agent });
  expect(operation.json()).toMatchObject({ status: 'outcome_unknown' });
  expect((await server.inject(request)).json()).toMatchObject({
    replay: true,
    operation: { status: 'outcome_unknown' },
  });
  expect(writes).toHaveBeenCalledOnce();
});
