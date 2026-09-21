import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApprovalGate, type ApprovalRequest } from './approval-gate.js';

let gate: ApprovalGate;
const request = (): ApprovalRequest => ({
  sessionId: 'session',
  action: { type: 'click', pageId: 'page', parameters: { answer: 'reviewed' } },
});
beforeEach(() => {
  gate = new ApprovalGate();
});
afterEach(async () => {
  await gate.shutdown();
  vi.restoreAllMocks();
});

it.each(['generated', 'lookup', 'list'])(
  'does not expose mutable token state through %s',
  async (surface) => {
    const input = request();
    const created = await gate.generateApprovalToken(input);
    const id = created.tokenId;
    const exposed =
      surface === 'generated'
        ? created
        : surface === 'lookup'
          ? await gate.getToken(id)
          : (await gate.getSessionTokens('session'))[0];
    expect(exposed).toBeDefined();
    if (!exposed) throw new Error('Missing fixture token');
    exposed.sessionId = 'other';
    exposed.actionFingerprint = 'forged';
    exposed.expiresAt = 0;
    exposed.status = 'used';
    expect(await gate.validateApprovalToken(id, input)).toBe(true);
    await gate.useApprovalToken(id);
    const used = await gate.getToken(id);
    if (!used) throw new Error('Missing used token');
    used.status = 'pending';
    expect(await gate.validateApprovalToken(id, input)).toBe(false);
  }
);

it('consumes a matching token only once under concurrent attempts', async () => {
  const input = request();
  const token = await gate.generateApprovalToken(input);
  const results = await Promise.all(
    Array.from({ length: 10 }, () => gate.consumeApprovalToken(token.tokenId, input))
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  expect((await gate.getToken(token.tokenId))?.status).toBe('used');
});

it('leaves a token available after a mismatch but never after success', async () => {
  const input = request();
  const token = await gate.generateApprovalToken(input);
  expect(await gate.consumeApprovalToken(token.tokenId, { ...input, sessionId: 'other' })).toBe(
    false
  );
  expect(
    await gate.consumeApprovalToken(token.tokenId, {
      ...input,
      action: { ...input.action, pageId: 'other' },
    })
  ).toBe(false);
  expect(await gate.consumeApprovalToken(token.tokenId, input)).toBe(true);
  expect(await gate.consumeApprovalToken(token.tokenId, input)).toBe(false);
});

it('refuses validation and both consumption paths at the expiry boundary', async () => {
  const input = request();
  const token = await gate.generateApprovalToken(input);
  vi.spyOn(Date, 'now').mockReturnValue(token.expiresAt);
  expect(await gate.validateApprovalToken(token.tokenId, input)).toBe(false);
  expect(await gate.consumeApprovalToken(token.tokenId, input)).toBe(false);
  await expect(gate.useApprovalToken(token.tokenId)).rejects.toMatchObject({
    code: 'INVALID_TOKEN',
  });
  vi.mocked(Date.now).mockReturnValue(token.createdAt);
  expect(await gate.validateApprovalToken(token.tokenId, input)).toBe(false);
});

it('legacy use refuses expiration even without a preceding validation', async () => {
  const token = await gate.generateApprovalToken(request());
  vi.spyOn(Date, 'now').mockReturnValue(token.expiresAt + 1);
  await expect(gate.useApprovalToken(token.tokenId)).rejects.toMatchObject({
    code: 'INVALID_TOKEN',
  });
});

it('rejects getters without invoking them or minting a token', async () => {
  const getter = vi.fn(() => 'session');
  const input = Object.defineProperty({ action: { type: 'click' } }, 'sessionId', {
    enumerable: true,
    get: getter,
  });
  await expect(gate.generateApprovalToken(input as ApprovalRequest)).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  });
  expect(getter).not.toHaveBeenCalled();
  expect(gate.getTokenCount()).toBe(0);
});

it.each([undefined, Number.NaN, 'x'.repeat(65536), Array(4096).fill(0)])(
  'refuses non-JSON or unbounded request parameters without value-bearing errors',
  async (value) => {
    const input = { sessionId: 'session', action: { type: 'fill', parameters: { value } } };
    await expect(gate.generateApprovalToken(input)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(gate.getTokenCount()).toBe(0);
  }
);

it('finishes caller-controlled inspection before looking up live token state', async () => {
  const input = request();
  const token = await gate.generateApprovalToken(input);
  let inner: Promise<boolean> | undefined;
  const reentrant = new Proxy(input, {
    ownKeys(target) {
      inner ??= gate.consumeApprovalToken(token.tokenId, input);
      return Reflect.ownKeys(target);
    },
  });
  expect(await gate.consumeApprovalToken(token.tokenId, reentrant)).toBe(false);
  expect(await inner).toBe(true);
});

it('does not authorize a token when request inspection shuts down its owner', async () => {
  const input = request();
  const token = await gate.generateApprovalToken(input);
  const reentrant = new Proxy(input, {
    ownKeys(target) {
      void gate.shutdown();
      return Reflect.ownKeys(target);
    },
  });
  expect(await gate.consumeApprovalToken(token.tokenId, reentrant)).toBe(false);
  expect(gate.getTokenCount()).toBe(0);
});

it('binds canonical data without depending on object insertion order', async () => {
  const token = await gate.generateApprovalToken({
    sessionId: 'session',
    action: {
      type: 'click',
      parameters: { a: 1, z: [2, 3] },
    },
  });
  expect(
    await gate.consumeApprovalToken(token.tokenId, {
      action: {
        parameters: { z: [2, 3], a: 1 },
        type: 'click',
      },
      sessionId: 'session',
    })
  ).toBe(true);
});

it('snapshots session and action together before cleanup can yield', async () => {
  await gate.shutdown();
  gate = new ApprovalGate({ maxTokens: 1 });
  const used = await gate.generateApprovalToken(request());
  await gate.useApprovalToken(used.tokenId);
  const input = request();
  const generated = gate.generateApprovalToken(input);
  input.sessionId = 'changed';
  input.action.parameters = { answer: 'changed' };
  const token = await generated;
  expect(token.sessionId).toBe('session');
  expect(await gate.validateApprovalToken(token.tokenId, request())).toBe(true);
});

it('cannot mint a token after shutdown while cleanup is yielding', async () => {
  await gate.shutdown();
  gate = new ApprovalGate({ maxTokens: 1 });
  const used = await gate.generateApprovalToken(request());
  await gate.useApprovalToken(used.tokenId);
  const generated = gate.generateApprovalToken(request());
  const rejected = expect(generated).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  await gate.shutdown();
  await rejected;
  expect(gate.getTokenCount()).toBe(0);
  await expect(gate.generateApprovalToken(request())).rejects.toMatchObject({
    code: 'INVALID_TOKEN',
  });
});
