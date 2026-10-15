/**
 * T4 A1 over HTTP: a mismatched read is a 400 like any invalid read result; a mismatched write
 * has already run, so it is a 500 internal fault whose operation stays dispatched with an
 * unknown outcome — never a 400 that invites a "fixed" retry of the side effect.
 */
import { createHash } from 'node:crypto';
import { defineApplicationOperation } from '@agentbrowser/control';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it } from 'vitest';
import { buildServer } from './server.js';
import {
  agentHeaders,
  bindAndDelegate,
  operatorHeaders,
} from './test-support/application-counter-http.js';

const parseOutput = (value: unknown) => {
  if (typeof (value as { total?: unknown })?.total !== 'number') throw new Error('PRIVATE-PARSER');
  return value as { total: number };
};

async function server() {
  let effects = 0;
  const app = await buildServer({
    engine: new FakeEngine(),
    apiKeys: new Map([[createHash('sha256').update('owner').digest('hex'), 'owner']]),
    applicationAdapters: [
      {
        id: 'owned-counter',
        authorize: ({ tenant, resource }) => tenant === 'owner' && resource === 'account',
        operations: {
          add: defineApplicationOperation({
            mode: 'write',
            parse: (input: unknown) => input,
            execute: async () => {
              effects += 1;
              return { status: 'committed' as const, value: { wrong: 'PRIVATE-VALUE' } };
            },
            parseOutput,
          }),
          balance: defineApplicationOperation({
            mode: 'read',
            parse: () => undefined,
            execute: async () => ({ status: 'read' as const, value: { wrong: 'PRIVATE-VALUE' } }),
            parseOutput,
          }),
        },
        receipt: async () => ({ verification: 'unknown' }),
      },
    ],
  });
  return { app, effects: () => effects };
}

it('a mismatched write is a 500 with an unknown outcome, and its replay never re-runs the effect', async () => {
  const { app, effects } = await server();
  try {
    const { path, token } = await bindAndDelegate(app);
    const payload = { operation: 'add', input: 1, operationId: 'w-1', expectedVersion: 0 };
    const first = await app.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(token),
      payload,
    });
    expect(first.statusCode).toBe(500);
    expect(first.json().error.code).toBe('INTERNAL');
    expect(first.body).not.toContain('PRIVATE');
    const replay = await app.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(token),
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      replay: true,
      operation: { status: 'outcome_unknown', dispatched: true },
    });
    expect(effects()).toBe(1);
    const status = await app.inject({ url: `${path}/operations/w-1`, headers: operatorHeaders });
    expect(status.json()).toMatchObject({ status: 'outcome_unknown', dispatched: true });
  } finally {
    await app.close();
  }
});

it('a mismatched read is a 400 that echoes nothing', async () => {
  const { app } = await server();
  try {
    const { path, token } = await bindAndDelegate(app);
    const read = await app.inject({
      method: 'POST',
      url: `${path}/application/execute`,
      headers: agentHeaders(token),
      payload: { operation: 'balance', input: null },
    });
    expect(read.statusCode).toBe(400);
    expect(read.json().error).toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Invalid application output',
    });
    expect(read.body).not.toContain('PRIVATE');
  } finally {
    await app.close();
  }
});
