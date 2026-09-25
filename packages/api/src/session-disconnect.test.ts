import { createHash } from 'node:crypto';
import { setImmediate as settle } from 'node:timers/promises';
import { SessionCoordinator } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { AgentBrowserService } from './service.js';

function observedEngine() {
  const engine = new FakeEngine();
  const loss = new AbortController();
  const allocate = engine.createSession.bind(engine);
  vi.spyOn(engine, 'createSession').mockImplementation(async (options) => {
    const session = await allocate(options);
    Object.defineProperty(session, 'disconnected', { value: loss.signal });
    return session;
  });
  return { engine, loss };
}

it('publishes disconnect only to its operator and immediately revokes delegated authority', async () => {
  const { engine, loss } = observedEngine();
  const server = await buildServer({
    engine,
    apiKeys: new Map([
      [createHash('sha256').update('owner').digest('hex'), 'owner'],
      [createHash('sha256').update('other').digest('hex'), 'other'],
    ]),
  });
  const headers = { authorization: 'Bearer owner' };
  try {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: { controlMode: 'delegated' },
    });
    expect(created.statusCode).toBe(201);
    const url = `/v1/sessions/${created.json().sessionId}`;
    await settle();
    const review = await server.inject({
      method: 'POST',
      url: `${url}/control/prepare-resume`,
      headers,
    });
    expect(review.statusCode).toBe(200);
    await settle();
    const grant = await server.inject({
      method: 'POST',
      url: `${url}/control/delegate`,
      headers,
      payload: { epoch: review.json().epoch },
    });
    expect(grant.statusCode).toBe(200);
    await settle();
    loss.abort('secret engine endpoint');
    const revoked = await server.inject({
      url,
      headers: { authorization: `Bearer ${grant.json().token}` },
    });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.body).not.toContain('sessionTerminal');
    const owner = await server.inject({ url, headers });
    expect(owner.statusCode).toBe(404);
    expect(owner.json().error.details.sessionTerminal).toMatchObject({
      closeCause: 'engine_disconnected',
      state: 'engine_disconnected',
      leaseRemainingMs: 0,
    });
    expect(owner.body).not.toContain('secret');
    const otherHeaders = { authorization: 'Bearer other' };
    const other = await server.inject({ url, headers: otherHeaders });
    const missing = await server.inject({ url: '/v1/sessions/missing', headers: otherHeaders });
    expect(other.json()).toEqual(missing.json());
    expect(other.body).not.toContain('sessionTerminal');
  } finally {
    await server.close();
  }
});

it('reconciles a disconnect without calling it session expiry', async () => {
  vi.useFakeTimers();
  const { engine, loss } = observedEngine();
  const coordinator = new SessionCoordinator();
  const service = new AgentBrowserService({ engine, coordinator, sweepIntervalMs: 10 });
  try {
    const { sessionId } = await service.createSession({});
    const events: unknown[] = [];
    service.subscribe(sessionId, (event) => events.push(event));
    loss.abort();
    await vi.advanceTimersByTimeAsync(10);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'page.destroyed',
        data: { reason: 'engine-disconnected' },
      })
    );
    expect(JSON.stringify(events)).not.toContain('session-expired');
  } finally {
    await service.shutdown();
    vi.useRealTimers();
  }
});
