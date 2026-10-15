/**
 * T5 J-a (C4b fixes): an explicit `executionRequirement: 'ephemeral'` is the default made
 * explicit — accepted and indistinguishable from omission (same operation identity, so the
 * second call is a replay); `durable` is refused while no durable store is qualified; REST
 * discovery publishes `writeExecution` when bound and stays `null` when unbound.
 */
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';
import {
  agentHeaders,
  bindAndDelegate,
  buildApplicationServer,
  operatorHeaders,
} from './test-support/application-counter-http.js';

it('explicit ephemeral equals omission: accepted, and the same operation replays instead of conflicting', async () => {
  const { server, state } = await buildApplicationServer();
  try {
    const { path, token } = await bindAndDelegate(server);
    const execute = (payload: Record<string, unknown>) =>
      server.inject({
        method: 'POST',
        url: `${path}/application/execute`,
        headers: agentHeaders(token),
        payload,
      });
    const base = { operation: 'add', input: 1, operationId: 'req-1', expectedVersion: 0 };
    const first = await execute(base);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'committed' });
    const explicit = await execute({ ...base, executionRequirement: 'ephemeral' });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json()).toMatchObject({ replay: true });
    expect(state.total).toBe(1);

    // And the other order: explicit first, omission second.
    const second = { ...base, operationId: 'req-2', expectedVersion: 1 };
    expect((await execute({ ...second, executionRequirement: 'ephemeral' })).json()).toMatchObject({
      status: 'committed',
    });
    expect((await execute(second)).json()).toMatchObject({ replay: true });
    expect(state.total).toBe(2);
  } finally {
    await server.close();
  }
});

it('durable is refused before anything executes while no durable store is qualified', async () => {
  const { server, state } = await buildApplicationServer();
  try {
    const { path, token } = await bindAndDelegate(server);
    const refused = await server.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(token),
      payload: {
        operation: 'add',
        input: 1,
        operationId: 'durable-1',
        expectedVersion: 0,
        executionRequirement: 'durable',
      },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('CONTROL_REQUIRED');
    expect(state.total).toBe(0);
    // No identity was reserved: the same operation ID is still free.
    const status = await server.inject({
      url: `${path}/operations/durable-1`,
      headers: operatorHeaders,
    });
    expect(status.statusCode).toBe(404);
  } finally {
    await server.close();
  }
});

it('REST discovery publishes writeExecution when bound and null when unbound', async () => {
  const { server } = await buildApplicationServer();
  try {
    const { path, token } = await bindAndDelegate(server);
    const bound = await server.inject({ url: `${path}/application`, headers: agentHeaders(token) });
    expect(bound.statusCode).toBe(200);
    expect(bound.json()).toMatchObject({
      adapter: 'owned-counter',
      writeExecution: { defaultRequirement: 'ephemeral', supportedRequirements: ['ephemeral'] },
    });

    const created = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: operatorHeaders,
      payload: { controlMode: 'delegated' },
    });
    const unbound = await server.inject({
      url: `/v1/sessions/${created.json().sessionId}/application`,
      headers: operatorHeaders,
    });
    expect(unbound.statusCode).toBe(200);
    expect(unbound.json()).toBeNull();
  } finally {
    await server.close();
  }
});

describe('service-level execution requirement (J-a review)', () => {
  const operator = { actor: 'operator', tenant: 'owner' } as const;
  async function serviceWith(durableJournalAvailable: boolean) {
    let effects = 0;
    const service = new AgentBrowserService({
      engine: new FakeEngine(),
      durableJournalAvailable,
      applicationAdapters: [
        {
          id: 'owned-counter',
          authorize: () => true,
          operations: {
            add: {
              mode: 'write' as const,
              prepare: () => async () => {
                effects += 1;
                return { status: 'committed' as const, value: effects };
              },
            },
          },
          receipt: async () => ({}),
        },
      ],
    });
    const { sessionId } = await service.createSession({
      tenantId: 'owner',
      controlMode: 'delegated',
    });
    service.applicationBind(sessionId, operator, { adapter: 'owned-counter', resource: 'account' });
    return { service, sessionId, effects: () => effects };
  }

  it('the deprecated availability flag alone never enables durable: refused, no effect, no identity', async () => {
    const s = await serviceWith(true);
    try {
      await expect(
        s.service.applicationExecute(s.sessionId, operator, {
          operation: 'add',
          input: 1,
          operationId: 'd1',
          expectedVersion: 0,
          executionRequirement: 'durable',
        })
      ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
      expect(s.effects()).toBe(0);
      // Discovery does not advertise what execute refuses.
      expect(await s.service.applicationDiscover(s.sessionId, operator)).toMatchObject({
        writeExecution: { supportedRequirements: ['ephemeral'] },
      });
    } finally {
      await s.service.shutdown();
    }
  });

  it('an explicit ephemeral does not bypass the caller-data checks', async () => {
    const s = await serviceWith(false);
    try {
      const withGetter = {
        operation: 'add',
        operationId: 'g1',
        expectedVersion: 0,
        executionRequirement: 'ephemeral',
        get input() {
          return 1;
        },
      };
      const nullProto = Object.assign(Object.create(null), {
        operation: 'add',
        input: 1,
        operationId: 'g2',
        expectedVersion: 0,
        executionRequirement: 'ephemeral',
      });
      for (const request of [withGetter, nullProto])
        await expect(
          s.service.applicationExecute(s.sessionId, operator, request)
        ).rejects.toThrow();
      expect(s.effects()).toBe(0);
    } finally {
      await s.service.shutdown();
    }
  });
});

it('a continuation may carry supersedes: valid links commit, malformed ones are refused before execution (J3c part 2)', async () => {
  const { server, state } = await buildApplicationServer();
  try {
    const { path, token } = await bindAndDelegate(server);
    const execute = (payload: Record<string, unknown>) =>
      server.inject({
        method: 'POST',
        url: `${path}/application/execute`,
        headers: agentHeaders(token),
        payload,
      });
    const base = { operation: 'add', input: 1, operationId: 'continuation-1', expectedVersion: 0 };
    const linked = await execute({
      ...base,
      supersedes: { namespace: 'agentbrowser', operationId: 'closed-op' },
    });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json()).toMatchObject({ status: 'committed' });
    // Metadata only: the same operation without the link is the same identity — a replay.
    expect((await execute(base)).json()).toMatchObject({ replay: true });
    expect(state.total).toBe(1);
    for (const supersedes of [
      { namespace: 'agentbrowser', operationId: 'bad id' },
      { namespace: 'agentbrowser', operationId: 'closed-op', extra: 1 },
      { operationId: 'closed-op' },
      'closed-op',
    ]) {
      const refused = await execute({ ...base, operationId: 'continuation-2', supersedes });
      expect(refused.statusCode).toBe(400);
    }
    expect(state.total).toBe(1);
  } finally {
    await server.close();
  }
});
