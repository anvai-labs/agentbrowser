import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

it('keeps an aborted HTTP mutation draining until the actual browser promise settles', async () => {
  const engine = new FakeEngine();
  const headers = { authorization: 'Bearer operator' };
  const server = await buildServer({
    engine,
    apiKeys: new Map([[createHash('sha256').update('operator').digest('hex'), 'owner']]),
  });
  const release = Promise.withResolvers<void>();
  try {
    await server.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
    const create = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: { controlMode: 'delegated' },
    });
    const path = `/v1/sessions/${create.json().sessionId}`;
    const page = await server.inject({
      method: 'POST',
      url: `${path}/pages`,
      headers: { ...headers, 'x-agentbrowser-operation-id': 'page' },
    });
    const pageId = page.json().pageId;
    const review = await server.inject({
      method: 'POST',
      url: `${path}/control/prepare-resume`,
      headers,
    });
    const grant = await server.inject({
      method: 'POST',
      url: `${path}/control/delegate`,
      headers,
      payload: { epoch: review.json().epoch },
    });
    const raw = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
    const act = raw.act.bind(raw);
    const entered = Promise.withResolvers<void>();
    vi.spyOn(raw, 'act').mockImplementation(async (action) => {
      entered.resolve();
      await release.promise;
      return act(action);
    });
    const abort = new AbortController();
    const pending = fetch(`${base}${path}/pages/${pageId}/act`, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        authorization: `Bearer ${grant.json().token}`,
        'content-type': 'application/json',
        'x-agentbrowser-operation-id': 'aborted',
      },
      body: JSON.stringify({ action: 'press', key: 'Tab' }),
    });
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    abort.abort();
    await rejected;
    expect((await server.inject({ url: `${path}/control`, headers })).json().busy).toBe(true);
    expect(
      (await server.inject({ method: 'POST', url: `${path}/control/takeover`, headers })).json()
        .state
    ).toBe('PAUSE_REQUESTED');
    release.resolve();
    await vi.waitFor(async () =>
      expect((await server.inject({ url: `${path}/control`, headers })).json()).toMatchObject({
        state: 'HUMAN_ACTIVE',
        busy: false,
      })
    );
    expect(
      (await server.inject({ url: `${path}/operations/aborted`, headers })).json()
    ).toMatchObject({ status: 'outcome_unknown', dispatched: true });
  } finally {
    release.resolve();
    await server.close();
  }
});
