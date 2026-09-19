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

const intentScope = {
  tenant: 'tenant-a',
  resource: 'counter-a',
  sessionId: 'session-a',
  sessionIncarnation: 'incarnation-a',
};
async function uiSubmit(app: Awaited<ReturnType<typeof startVersionedApp>>, amount = 2) {
  const html = await (await fetch(app.url)).text();
  const action = html.match(/action="([^"]+)"/u)?.[1];
  expect(action).toMatch(/^\/ui-submit\//u);
  return fetch(`${app.url}${action}`, { method: 'POST', body: JSON.stringify({ amount }) });
}

it('reserves a scoped intent without effects and only its UI handler creates evidence', async () => {
  const app = await startVersionedApp();
  try {
    const intent = app.reserveIntent(intentScope, 2);
    expect(app.oracle.snapshot()).toEqual({ version: 0, total: 0 });
    expect(Object.isFrozen(intent.scope)).toBe(true);
    expect(app.intentReceipt(intentScope, intent.command.operationId)).toBeUndefined();
    const direct = await fetch(`${app.url}/commands`, {
      method: 'POST',
      body: JSON.stringify(intent.command),
    });
    expect(direct.status).toBe(409);
    expect((await uiSubmit(app)).status).toBe(409); // A page load is not an admission.
    app.claimIntent(intentScope, intent.command.operationId, intent.command);
    expect(app.oracle.snapshot()).toEqual({ version: 0, total: 0 });
    expect(app.intentReceipt(intentScope, intent.command.operationId)).toBeUndefined();
    const response = await uiSubmit(app);
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toMatchObject({
      ...intent.command,
      version: 1,
      total: 2,
      scope: intentScope,
      channel: 'reserved_ui',
    });
    expect((await fetch(`${app.url}/receipts/${intent.command.operationId}`)).status).toBe(404);
    expect(receipt.eventId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(await (await uiSubmit(app)).json()).toEqual(receipt);
    expect(app.oracle.snapshot()).toEqual({ version: 1, total: 2 });
    expect(app.intentReceipt(intentScope, intent.command.operationId)).toEqual(receipt);
    expect(() =>
      app.claimIntent(intentScope, intent.command.operationId, intent.command)
    ).toThrow();
  } finally {
    await app.close();
  }
});

it.each(['tenant', 'resource', 'sessionId', 'sessionIncarnation'] as const)(
  'rejects another %s before claiming or observing an intent',
  async (field) => {
    const app = await startVersionedApp();
    try {
      const intent = app.reserveIntent(intentScope, 2);
      const other = { ...intentScope, [field]: 'other' };
      expect(() => app.claimIntent(other, intent.command.operationId, intent.command)).toThrow();
      expect(() => app.intentReceipt(other, intent.command.operationId)).toThrow();
      app.claimIntent(intentScope, intent.command.operationId, intent.command);
      expect((await uiSubmit(app)).status).toBe(200);
    } finally {
      await app.close();
    }
  }
);

it('refuses a pre-existing receipt even when its command and correlation match exactly', async () => {
  const app = await startVersionedApp();
  try {
    const intent = app.reserveIntent(intentScope, 2);
    app.oracle.execute(intent.command); // Independent historical writer, not a UI event.
    expect(() =>
      app.claimIntent(intentScope, intent.command.operationId, intent.command)
    ).toThrow();
    expect(app.intentReceipt(intentScope, intent.command.operationId)).toBeUndefined();
    expect((await uiSubmit(app)).status).toBe(409);
    expect(app.oracle.snapshot().version).toBe(1);
  } finally {
    await app.close();
  }
});

it('cannot label a direct or stale-version commit as a fresh UI event after preflight', async () => {
  const app = await startVersionedApp();
  try {
    const intent = app.reserveIntent(intentScope, 2);
    app.claimIntent(intentScope, intent.command.operationId, intent.command);
    app.oracle.execute({ operationId: 'other-writer', expectedVersion: 0, amount: 1 });
    expect((await uiSubmit(app)).status).toBe(409);
    expect(app.intentReceipt(intentScope, intent.command.operationId)).toBeUndefined();
    expect(app.oracle.snapshot()).toEqual({ version: 1, total: 1 });
  } finally {
    await app.close();
  }
});

it('requires the reserved amount and returns detached receipt data', async () => {
  const app = await startVersionedApp();
  try {
    const intent = app.reserveIntent(intentScope, 2);
    expect(() => app.reserveIntent(intentScope, 2)).toThrow();
    expect(() =>
      app.claimIntent(intentScope, intent.command.operationId, { ...intent.command, amount: 3 })
    ).toThrow();
    app.claimIntent(intentScope, intent.command.operationId, intent.command);
    expect((await uiSubmit(app, 3)).status).toBe(409);
    expect((await uiSubmit(app)).status).toBe(200);
    const receipt = app.intentReceipt(intentScope, intent.command.operationId);
    if (!receipt) throw new Error('Expected scoped UI receipt');
    receipt.total = 99;
    receipt.scope.resource = 'changed';
    expect(app.intentReceipt(intentScope, intent.command.operationId)).toMatchObject({
      total: 2,
      scope: intentScope,
    });
  } finally {
    await app.close();
  }
});
