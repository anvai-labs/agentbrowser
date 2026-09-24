import { createHash } from 'node:crypto';
import type { ApplicationAdapter, ApplicationScope } from '@agentbrowser/control';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect } from 'vitest';
import { buildServer } from '../server.js';

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
export const buildApplicationServer = async (
  authorize: ApplicationAdapter['authorize'] = ({ tenant, resource }) =>
    tenant === 'owner' && resource === 'account',
  beforeCommit?: () => Promise<void>
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
            await beforeCommit?.();
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

export const operatorHeaders = { authorization: 'Bearer owner' };

/** Create a delegated session, bind the counter adapter and delegate an application-mode grant. */
export const bindAndDelegate = async (
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

export const agentHeaders = (token: string) => ({ authorization: `Bearer ${token}` });
