import { createHash } from 'node:crypto';
import type { ApplicationAdapter, ApplicationScope } from '@agentbrowser/control';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it } from 'vitest';
import { buildServer } from './server.js';

/**
 * Application-surface oracle (shared-infra slice 2).
 *
 * The adapter's committed state lives OUTSIDE the service and is inspected
 * directly, so asserted HTTP receipts are checked against an independent
 * truth - exactly like packages/control/scripts/accept-deployment.mjs.
 * The business version IS the counter: one write wins, a loser (stale
 * expectedVersion) is an admitted rejection, and a replayed operation ID
 * returns the recorded operation without re-executing.
 */
const buildApplicationServer = async (
  authorize: ApplicationAdapter['authorize'] = ({ tenant, resource }) =>
    tenant === 'owner' && resource === 'account'
) => {
  const state = { total: 0 };
  const receipts = new Map<string, { operationId: string; total: number }>();
  const receiptKey = (scope: ApplicationScope, id = scope.operationId) =>
    `${scope.tenant}\0${scope.resource}\0${scope.sessionIncarnation}\0${id}`;
  const adapter = {
    id: 'owned-counter',
    authorize,
    operations: {
      add: {
        mode: 'write' as const,
        prepare(input: unknown) {
          if (input !== 1) throw new Error('counter fixture only adds 1');
          return async (scope: ApplicationScope) => {
            if (scope.expectedVersion !== state.total)
              return { status: 'rejected' as const, reason: 'stale business version' };
            state.total += 1;
            const receipt = {
              operationId: scope.operationId ?? 'unidentified',
              total: state.total,
            };
            receipts.set(receiptKey(scope), receipt);
            return { status: 'committed' as const, value: receipt };
          };
        },
      },
      balance: {
        mode: 'read' as const,
        prepare() {
          return async () => ({ status: 'read' as const, value: state.total });
        },
      },
    },
    async receipt(scope: ApplicationScope, operationId: string) {
      return receipts.get(receiptKey(scope, operationId));
    },
  };
  const server = await buildServer({
    engine: new FakeEngine(),
    apiKeys: new Map([
      [createHash('sha256').update('owner').digest('hex'), 'owner'],
      [createHash('sha256').update('intruder').digest('hex'), 'intruder'],
    ]),
    applicationAdapters: [adapter],
  });
  return { server, state };
};

const operatorHeaders = { authorization: 'Bearer owner' };

/** Create a delegated session, bind the counter adapter and delegate an application-mode grant. */
const bindAndDelegate = async (
  server: Awaited<ReturnType<typeof buildApplicationServer>>['server'],
  mode = 'application'
) => {
  const create = await server.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: operatorHeaders,
    payload: { controlMode: 'delegated' },
  });
  const path = `/v1/sessions/${create.json().sessionId}`;
  const bound = await server.inject({
    method: 'PUT',
    url: `${path}/application`,
    headers: operatorHeaders,
    payload: { adapter: 'owned-counter', resource: 'account' },
  });
  expect(bound.statusCode).toBe(200);
  const review = await server.inject({
    method: 'POST',
    url: `${path}/control/prepare-resume`,
    headers: operatorHeaders,
  });
  const grant = await server.inject({
    method: 'POST',
    url: `${path}/control/delegate`,
    headers: operatorHeaders,
    payload: { epoch: review.json().epoch, mode },
  });
  return { path, token: grant.json().token as string };
};

const agentHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

it('returns no discovery while unbound and lists operations after binding', async () => {
  const { server } = await buildApplicationServer();
  try {
    const { path, token } = await bindAndDelegate(server);
    // Bound: discovery describes the adapter's operation contract.
    const discovered = await server.inject({
      url: `${path}/application`,
      headers: agentHeaders(token),
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json()).toEqual({
      adapter: 'owned-counter',
      resource: 'account',
      operations: [
        { name: 'add', mode: 'write' },
        { name: 'balance', mode: 'read' },
      ],
    });
    // A different tenant's fresh session sees no binding of its own.
    const other = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: 'Bearer intruder' },
      payload: { controlMode: 'delegated' },
    });
    const empty = await server.inject({
      url: `/v1/sessions/${other.json().sessionId}/application`,
      headers: { authorization: 'Bearer intruder' },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toBeNull();
  } finally {
    await server.close();
  }
});

it('rejects binding from a tenant the adapter does not authorize', async () => {
  const { server } = await buildApplicationServer();
  try {
    const create = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: 'Bearer intruder' },
      payload: { controlMode: 'delegated' },
    });
    const path = `/v1/sessions/${create.json().sessionId}`;
    const bind = await server.inject({
      method: 'PUT',
      url: `${path}/application`,
      headers: { authorization: 'Bearer intruder' },
      payload: { adapter: 'owned-counter', resource: 'account' },
    });
    expect(bind.statusCode).toBe(403);
    // The intruder's own session stays unbound; zero effects anywhere.
    const discovered = await server.inject({
      url: `${path}/application`,
      headers: { authorization: 'Bearer intruder' },
    });
    expect(discovered.json()).toBeNull();
  } finally {
    await server.close();
  }
});

it('refuses a second bind while the delegated agent owns the session', async () => {
  const { server } = await buildApplicationServer();
  try {
    const { path } = await bindAndDelegate(server);
    const bind = await server.inject({
      method: 'PUT',
      url: `${path}/application`,
      headers: operatorHeaders,
      payload: { adapter: 'owned-counter', resource: 'resource-2' },
    });
    expect(bind.statusCode).toBe(403);
  } finally {
    await server.close();
  }
});

it('commits a write once, replays the duplicate, and rejects the stale loser', async () => {
  const { server, state } = await buildApplicationServer();
  try {
    const { path, token } = await bindAndDelegate(server);
    // Writes demand an operation identity up front.
    const shapeless = await server.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(token),
      payload: { operation: 'add', input: 1 },
    });
    expect(shapeless.statusCode).toBe(400);
    const committed = await server.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(token),
      payload: { operation: 'add', input: 1, operationId: 'effect-1', expectedVersion: 0 },
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json()).toEqual({
      status: 'committed',
      value: { operationId: 'effect-1', total: 1 },
    });
    expect(state.total).toBe(1);
    // Same operation ID: a replay of the recorded operation, no second effect.
    const replay = await server.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(token),
      payload: { operation: 'add', input: 1, operationId: 'effect-1', expectedVersion: 0 },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      replay: true,
      operation: { operationId: 'effect-1', status: 'completed', dispatched: true },
    });
    expect(state.total).toBe(1);
    // A different ID at the same business version loses: admitted rejection.
    const loser = await server.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(token),
      payload: { operation: 'add', input: 1, operationId: 'effect-2', expectedVersion: 0 },
    });
    expect(loser.statusCode).toBe(200);
    expect(loser.json()).toEqual({ status: 'rejected', reason: 'stale business version' });
    expect(state.total).toBe(1);
    // Reads carry no write identity and see the committed total.
    const readWithIdentity = await server.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(token),
      payload: { operation: 'balance', input: null, operationId: 'read-1' },
    });
    expect(readWithIdentity.statusCode).toBe(400);
    const balance = await server.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(token),
      payload: { operation: 'balance', input: null },
    });
    expect(balance.statusCode).toBe(200);
    expect(balance.json()).toEqual({ status: 'read', value: 1 });
  } finally {
    await server.close();
  }
});

it('serves receipts independently of the revoked grant', async () => {
  const { server, state } = await buildApplicationServer();
  try {
    const { path, token } = await bindAndDelegate(server);
    const commit = await server.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(token),
      payload: { operation: 'add', input: 1, operationId: 'effect-1', expectedVersion: 0 },
    });
    expect(commit.json().status).toBe('committed');
    // Stale grant: the operator takes over; the token must go dead.
    await server.inject({
      method: 'POST',
      url: `${path}/control/takeover`,
      headers: operatorHeaders,
    });
    expect(
      await server
        .inject({ url: `${path}/application`, headers: agentHeaders(token) })
        .then((r) => r.statusCode)
    ).toBe(401);
    const dead = await server.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(token),
      payload: { operation: 'add', input: 1, operationId: 'effect-9', expectedVersion: 1 },
    });
    expect(dead.statusCode).toBe(401);
    expect(state.total).toBe(1);
    // The committed receipt outlives the grant and stays operator-readable.
    const receipt = await server.inject({
      url: `${path}/application/receipts/effect-1`,
      headers: operatorHeaders,
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toEqual({ operationId: 'effect-1', total: 1 });
    // Unknown but well-formed IDs read as null, not an error.
    const missing = await server.inject({
      url: `${path}/application/receipts/effect-404`,
      headers: operatorHeaders,
    });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toBeNull();
    // Malformed receipt IDs are refused outright.
    const malformed = await server.inject({
      url: `${path}/application/receipts/bad%20id`,
      headers: operatorHeaders,
    });
    expect(malformed.statusCode).toBe(400);
  } finally {
    await server.close();
  }
});

it('withholds the application surface from grants without the application capabilities', async () => {
  const { server, state } = await buildApplicationServer();
  try {
    const { path, token } = await bindAndDelegate(server, 'qa');
    // The default qa profile owns browser capabilities but never application ones.
    const discovered = await server.inject({
      url: `${path}/application`,
      headers: agentHeaders(token),
    });
    expect(discovered.statusCode).toBe(403);
    const executed = await server.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(token),
      payload: { operation: 'add', input: 1, operationId: 'effect-1', expectedVersion: 0 },
    });
    expect(executed.statusCode).toBe(403);
    expect(state.total).toBe(0);
    // One admitted principal at a time: while the qa grant owns the session
    // even the operator waits (receipts remain readable regardless - covered
    // by the revocation test). Takeover restores operator access.
    const operatorRead = await server.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: operatorHeaders,
      payload: { operation: 'balance', input: null },
    });
    expect(operatorRead.statusCode).toBe(403);
    await server.inject({
      method: 'POST',
      url: `${path}/control/takeover`,
      headers: operatorHeaders,
    });
    const restored = await server.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: operatorHeaders,
      payload: { operation: 'balance', input: null },
    });
    expect(restored.json()).toEqual({ status: 'read', value: 0 });
  } finally {
    await server.close();
  }
});

it('unbinds as the operator and leaves the surface inert', async () => {
  const { server, state } = await buildApplicationServer();
  try {
    const { path, token } = await bindAndDelegate(server);
    // Unbind needs the human in control, like bind.
    await server.inject({
      method: 'POST',
      url: `${path}/control/takeover`,
      headers: operatorHeaders,
    });
    const unbound = await server.inject({
      method: 'DELETE',
      url: `${path}/application`,
      headers: operatorHeaders,
    });
    expect(unbound.statusCode).toBe(200);
    expect(unbound.json()).toEqual({ unbound: true });
    // Re-delegate: the fresh grant discovers nothing and cannot execute.
    const review = await server.inject({
      method: 'POST',
      url: `${path}/control/prepare-resume`,
      headers: operatorHeaders,
    });
    const grant = await server.inject({
      method: 'POST',
      url: `${path}/control/delegate`,
      headers: operatorHeaders,
      payload: { epoch: review.json().epoch, mode: 'application' },
    });
    const fresh = grant.json().token as string;
    const discovered = await server.inject({
      url: `${path}/application`,
      headers: agentHeaders(fresh),
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json()).toBeNull();
    const executed = await server.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(fresh),
      payload: { operation: 'add', input: 1, operationId: 'effect-1', expectedVersion: 0 },
    });
    expect(executed.statusCode).toBe(403);
    expect(state.total).toBe(0);
  } finally {
    await server.close();
  }
});

it('denies malformed application policy over HTTP without effects or private diagnostics', async () => {
  let allowed = true;
  const { server, state } = await buildApplicationServer(
    () => (allowed ? true : Promise.reject(new Error('PRIVATE-AUTHORIZATION'))) as boolean
  );
  try {
    const { path, token } = await bindAndDelegate(server);
    allowed = false;
    const payload = { operation: 'add', input: 1, operationId: 'denied-1', expectedVersion: 0 };
    for (const request of [
      { method: 'GET' as const, url: `${path}/application`, headers: agentHeaders(token) },
      {
        method: 'POST' as const,
        url: `${path}/application/execute`,
        headers: agentHeaders(token),
        payload,
      },
      {
        method: 'GET' as const,
        url: `${path}/application/receipts/denied-1`,
        headers: operatorHeaders,
      },
    ]) {
      const response = await server.inject(request);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'CONTROL_REQUIRED' } });
      expect(response.body).not.toContain('PRIVATE-AUTHORIZATION');
    }
    allowed = true;
    const replay = await server.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(token),
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      replay: true,
      operation: { status: 'failed', dispatched: false },
    });
    expect(state.total).toBe(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    await server.close();
  }
});

it('keeps public review creation operator-only and rejects execution headers before allocation', async () => {
  const { server, state } = await buildApplicationServer();
  const payload = {
    pageId: 'unused-page',
    source: { ownerId: 'configured-owner', contract: { id: 'draft', version: '1' } },
    request: { operation: 'add', input: 1, operationId: 'future-write', expectedVersion: 0 },
  };
  try {
    const { path, token } = await bindAndDelegate(server);
    const delegated = await server.inject({
      method: 'POST',
      url: `${path}/application/reviews`,
      headers: agentHeaders(token),
      payload,
    });
    expect(delegated.statusCode).toBe(403);
    const foreign = await server.inject({
      method: 'POST',
      url: `${path}/application/reviews`,
      headers: { authorization: 'Bearer intruder' },
      payload,
    });
    expect(foreign.statusCode).toBe(403);
    const header = await server.inject({
      method: 'POST',
      url: `${path}/application/reviews`,
      headers: { ...operatorHeaders, 'x-agentbrowser-operation-id': 'future-write' },
      payload,
    });
    expect(header.statusCode).toBe(400);
    expect(header.json().error.code).toBe('INVALID_REQUEST');
    expect(header.headers['cache-control']).toBe('no-store');
    const operation = await server.inject({
      url: `${path}/operations/future-write`,
      headers: operatorHeaders,
    });
    expect(operation.statusCode).toBe(404);
    expect(state.total).toBe(0);
  } finally {
    await server.close();
  }
});
