import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalGate } from './approval-gate.js';

const context = () => ({
  tenant: 'owner',
  sessionId: 's',
  sessionIncarnation: 'inc',
  epoch: 0,
  reviewVersion: 'v1',
});
const request = () => ({
  sessionId: 's',
  action: { type: 'fill', value: 'private', parameters: { nested: { value: 'private' } } },
});
const gates: ApprovalGate[] = [];
function fixture(options = {}) {
  const gate = new ApprovalGate(options);
  gates.push(gate);
  return gate;
}
afterEach(async () => {
  for (const gate of gates.splice(0)) await gate.shutdown();
  vi.useRealTimers();
});

it('requires explicit approval and permits exactly one concurrent consume', async () => {
  const gate = fixture();
  const token = await gate.generateReviewedApproval(request(), context());
  expect(await gate.consumeReviewedApproval(token.tokenId, request(), context())).toBe(false);
  expect(await gate.decideReviewedApproval(token.tokenId, context(), 'approve')).toMatchObject({
    status: 'approved',
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      gate.consumeReviewedApproval(token.tokenId, request(), context())
    )
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await gate.decideReviewedApproval(token.tokenId, context(), 'approve')).toBeUndefined();
  expect(await gate.getReviewedApproval(token.tokenId, context())).toMatchObject({
    status: 'used',
  });
});

it('isolates legacy methods and reviewed tokens in both directions', async () => {
  const gate = fixture();
  const reviewed = await gate.generateReviewedApproval(request(), context());
  expect(await gate.validateApprovalToken(reviewed.tokenId, request())).toBe(false);
  expect(await gate.consumeApprovalToken(reviewed.tokenId, request())).toBe(false);
  await expect(gate.useApprovalToken(reviewed.tokenId)).rejects.toThrow();
  expect(await gate.getToken(reviewed.tokenId)).toBeUndefined();
  expect(await gate.getSessionTokens('s')).toEqual([]);
  const legacy = await gate.generateApprovalToken(request());
  expect(await gate.getReviewedApproval(legacy.tokenId, context())).toBeUndefined();
  expect(await gate.decideReviewedApproval(legacy.tokenId, context(), 'approve')).toBeUndefined();
  expect(await gate.consumeReviewedApproval(legacy.tokenId, request(), context())).toBe(false);
});

it('detaches private nested data on generation, lookup and decision', async () => {
  const gate = fixture();
  const input = request();
  const scope = context();
  const issued = await gate.generateReviewedApproval(input, scope);
  input.action.parameters.nested.value = 'caller changed';
  scope.reviewVersion = 'changed';
  for (const view of [
    issued,
    await gate.getReviewedApproval(issued.tokenId, context()),
    await gate.decideReviewedApproval(issued.tokenId, context(), 'approve'),
  ]) {
    if (!view) throw new Error('Missing view');
    (view.action.parameters as { nested: { value: string } }).nested.value = 'changed';
    view.status = 'used';
  }
  expect(await gate.getReviewedApproval(issued.tokenId, context())).toMatchObject({
    status: 'approved',
    action: { parameters: { nested: { value: 'private' } } },
  });
  expect(await gate.consumeReviewedApproval(issued.tokenId, request(), context())).toBe(true);
});

it.each(['tenant', 'sessionId', 'sessionIncarnation', 'epoch', 'reviewVersion'] as const)(
  'refuses changed authority %s without poisoning the valid record',
  async (key) => {
    const gate = fixture();
    const issued = await gate.generateReviewedApproval(request(), context());
    const wrong = { ...context(), [key]: key === 'epoch' ? 1 : 'different' };
    expect(await gate.getReviewedApproval(issued.tokenId, wrong)).toBeUndefined();
    expect(await gate.decideReviewedApproval(issued.tokenId, wrong, 'approve')).toBeUndefined();
    expect(await gate.getReviewedApproval(issued.tokenId, context())).toMatchObject({
      status: 'pending',
    });
  }
);

it('revokes approval by denial and never reapproves a denied challenge', async () => {
  const gate = fixture();
  const issued = await gate.generateReviewedApproval(request(), context());
  await gate.decideReviewedApproval(issued.tokenId, context(), 'approve');
  expect(await gate.decideReviewedApproval(issued.tokenId, context(), 'deny')).toMatchObject({
    status: 'denied',
  });
  expect(await gate.decideReviewedApproval(issued.tokenId, context(), 'deny')).toMatchObject({
    status: 'denied',
  });
  expect(await gate.decideReviewedApproval(issued.tokenId, context(), 'approve')).toBeUndefined();
  expect(await gate.consumeReviewedApproval(issued.tokenId, request(), context())).toBe(false);
});

it('does not extend expiry on repeated approval and observes the exact expiry boundary', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const gate = fixture({ tokenTtlMs: 100 });
  const issued = await gate.generateReviewedApproval(request(), context());
  const approved = await gate.decideReviewedApproval(issued.tokenId, context(), 'approve');
  vi.setSystemTime(1050);
  expect(await gate.decideReviewedApproval(issued.tokenId, context(), 'approve')).toEqual(approved);
  vi.setSystemTime(1100);
  expect(await gate.consumeReviewedApproval(issued.tokenId, request(), context())).toBe(false);
  expect(await gate.getReviewedApproval(issued.tokenId, context())).toMatchObject({
    status: 'expired',
  });
  vi.setSystemTime(1050);
  expect(await gate.decideReviewedApproval(issued.tokenId, context(), 'approve')).toBeUndefined();
});

it('shares capacity with confirmation and releases terminal records under pressure', async () => {
  const gate = fixture({ maxTokens: 1 });
  const issued = await gate.generateReviewedApproval(request(), context());
  await expect(gate.generateApprovalToken(request())).rejects.toMatchObject({
    code: 'QUOTA_EXCEEDED',
  });
  await gate.decideReviewedApproval(issued.tokenId, context(), 'deny');
  await expect(gate.generateApprovalToken(request())).resolves.toBeDefined();
  expect(gate.getTokenCount()).toBe(1);
  expect(await gate.getReviewedApproval(issued.tokenId, context())).toBeUndefined();
});

it('finishes reentrant input inspection before deciding or consuming live state', async () => {
  const gate = fixture();
  const issued = await gate.generateReviewedApproval(request(), context());
  await gate.decideReviewedApproval(issued.tokenId, context(), 'approve');
  let revoked: Promise<unknown> | undefined;
  const reentrant = new Proxy(context(), {
    ownKeys(target) {
      revoked ??= gate.decideReviewedApproval(issued.tokenId, context(), 'deny');
      return Reflect.ownKeys(target);
    },
  });
  expect(await gate.consumeReviewedApproval(issued.tokenId, request(), reentrant)).toBe(false);
  await revoked;
});

it('refuses action drift, malformed or oversized input and never mints after shutdown', async () => {
  const gate = fixture();
  const issued = await gate.generateReviewedApproval(request(), context());
  await gate.decideReviewedApproval(issued.tokenId, context(), 'approve');
  expect(
    await gate.consumeReviewedApproval(
      issued.tokenId,
      { ...request(), action: { type: 'click' } },
      context()
    )
  ).toBe(false);
  await expect(
    gate.generateReviewedApproval(request(), { ...context(), epoch: -1 })
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(
    gate.generateReviewedApproval(
      { ...request(), action: { type: 'fill', value: 'x'.repeat(70000) } },
      context()
    )
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await gate.shutdown();
  await expect(gate.generateReviewedApproval(request(), context())).rejects.toThrow();
});

it('snapshots reviewed data before cleanup yields and cannot mint after shutdown', async () => {
  const gate = fixture({ maxTokens: 1 });
  const first = await gate.generateApprovalToken(request());
  await gate.useApprovalToken(first.tokenId);
  const input = request();
  const scope = context();
  const pending = gate.generateReviewedApproval(input, scope);
  input.action.value = 'changed';
  scope.epoch = 42;
  const issued = await pending;
  expect(await gate.getReviewedApproval(issued.tokenId, context())).toMatchObject({
    action: { value: 'private' },
  });
  await gate.decideReviewedApproval(issued.tokenId, context(), 'deny');
  const closing = gate.generateReviewedApproval(request(), context());
  await gate.shutdown();
  await expect(closing).rejects.toThrow();
  expect(gate.getTokenCount()).toBe(0);
});

it('cannot reapprove a token consumed during context inspection', async () => {
  const gate = fixture();
  const issued = await gate.generateReviewedApproval(request(), context());
  await gate.decideReviewedApproval(issued.tokenId, context(), 'approve');
  let consumed: Promise<boolean> | undefined;
  const reentrant = new Proxy(context(), {
    ownKeys(target) {
      consumed ??= gate.consumeReviewedApproval(issued.tokenId, request(), context());
      return Reflect.ownKeys(target);
    },
  });
  expect(await gate.decideReviewedApproval(issued.tokenId, reentrant, 'approve')).toBeUndefined();
  expect(await consumed).toBe(true);
});

it.each([true, false])(
  'orders revoke and consume atomically (revoke first: %s)',
  async (revokeFirst) => {
    const gate = fixture();
    const issued = await gate.generateReviewedApproval(request(), context());
    await gate.decideReviewedApproval(issued.tokenId, context(), 'approve');
    const revoke = () => gate.decideReviewedApproval(issued.tokenId, context(), 'deny');
    const consume = () => gate.consumeReviewedApproval(issued.tokenId, request(), context());
    const results = revokeFirst
      ? await Promise.all([revoke(), consume()])
      : await Promise.all([consume(), revoke()]);
    expect(results[revokeFirst ? 1 : 0]).toBe(!revokeFirst);
    expect(await gate.getReviewedApproval(issued.tokenId, context())).toMatchObject({
      status: revokeFirst ? 'denied' : 'used',
    });
  }
);
