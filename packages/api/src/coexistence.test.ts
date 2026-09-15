import { createHash } from 'node:crypto';
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

async function delegate(server: Awaited<ReturnType<typeof buildServer>>, url: string) {
  const review = await server.inject({
    method: 'POST',
    url: `${url}/control/prepare-resume`,
    headers: operator,
  });
  expect(review.statusCode).toBe(200);
  const granted = await server.inject({
    method: 'POST',
    url: `${url}/control/delegate`,
    headers: operator,
    payload: { epoch: review.json().epoch },
  });
  expect(granted.statusCode).toBe(200);
  return { authorization: `Bearer ${granted.json().token}` };
}

describe('delegated coexistence', () => {
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
    const raw = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
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
    const raw = engine.getFakePage(engine.getSessionIds()[0]!, created.json().pageId)!;
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
    const raw = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
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
    const raw = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
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
});
