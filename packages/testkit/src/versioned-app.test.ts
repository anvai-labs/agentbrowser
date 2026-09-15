import { expect, it } from 'vitest';
import { VersionedCounter, assertCounterOutcome, startVersionedApp } from './versioned-app.js';

it('shares one version and idempotency boundary across application callers', () => {
  const app = new VersionedCounter();
  const command = { operationId: 'one', expectedVersion: 0, amount: 3 };
  const receipt = app.execute(command);
  expect(app.execute(command)).toEqual(receipt);
  expect(app.snapshot()).toEqual({ version: 1, total: 3 });
  expect(() => app.execute({ ...command, amount: 4 })).toThrow('OPERATION_CONFLICT');
  expect(() => app.execute({ ...command, operationId: 'two' })).toThrow('VERSION_CONFLICT');
  expect(app.receipt('two')).toBeUndefined();
  expect(app.snapshot()).toEqual({ version: 1, total: 3 });
  // Receipts and snapshots returned to clients cannot mutate the oracle.
  receipt.total = 100;
  expect(app.receipt('one')?.total).toBe(3);
});

it('requires server evidence rather than accepting a claimed success', () => {
  const app = new VersionedCounter();
  const command = { operationId: 'one', expectedVersion: 0, amount: 3 };
  expect(() => assertCounterOutcome(app, command)).toThrow('OUTCOME_NOT_VERIFIED');
  app.execute(command);
  assertCounterOutcome(app, command);
  expect(() => assertCounterOutcome(app, { ...command, amount: 4 })).toThrow(
    'OUTCOME_NOT_VERIFIED'
  );
});

it('bounds idempotency storage without evicting previously executed commands', () => {
  const app = new VersionedCounter(1);
  const first = { operationId: 'one', expectedVersion: 0, amount: 1 };
  app.execute(first);
  expect(() => app.execute({ operationId: 'two', expectedVersion: 1, amount: 1 })).toThrow(
    'CAPACITY_EXCEEDED'
  );
  expect(app.execute(first).version).toBe(1);
});

it('exposes typed commands, conflicts and receipt lookup over HTTP without a browser', async () => {
  const app = await startVersionedApp();
  try {
    const command = { operationId: 'http-one', expectedVersion: 0, amount: 2 };
    const send = (body: unknown) =>
      fetch(`${app.url}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await send(command)).status).toBe(200);
    expect((await send(command)).status).toBe(200);
    expect((await send({ ...command, amount: 3 })).status).toBe(409);
    expect((await send({ ...command, operationId: 'stale' })).status).toBe(409);
    expect((await send({ ...command, expectedVersion: '0' })).status).toBe(400);
    expect((await send({ ...command, amount: Number.MAX_SAFE_INTEGER })).status).toBe(400);
    expect((await send({ ...command, extra: 'ignored?' })).status).toBe(400);
    const receipt = await (await fetch(`${app.url}/receipts/http-one`)).json();
    expect(receipt).toMatchObject({ operationId: 'http-one', version: 1, total: 2 });
    assertCounterOutcome(app.oracle, command);
  } finally {
    await app.close();
  }
});

it('recovers an application outcome after a lost response without replaying a UI action', async () => {
  const app = await startVersionedApp({ loseFirstResponse: true });
  try {
    const command = { operationId: 'lost', expectedVersion: 0, amount: 2 };
    await expect(
      fetch(`${app.url}/commands`, { method: 'POST', body: JSON.stringify(command) }).then(
        (response) => response.json()
      )
    ).rejects.toThrow();
    const receipt = await (await fetch(`${app.url}/receipts/lost`)).json();
    expect(receipt).toMatchObject({ version: 1, total: 2 });
    assertCounterOutcome(app.oracle, command);
    expect(app.oracle.snapshot()).toEqual({ version: 1, total: 2 });
  } finally {
    await app.close();
  }
});
