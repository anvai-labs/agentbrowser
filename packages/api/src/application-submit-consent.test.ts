import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  ApplicationAuthority,
  ApplicationRequest,
  EvidenceReviewSource,
} from '@agentbrowser/control';
import { ApprovalGate } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentBrowserService, type ServiceDependencies } from './service.js';
import { createApplicationDraft } from './test-support/application-draft.js';

const operator = { actor: 'operator' as const, tenant: 'owner' };
const services: AgentBrowserService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.shutdown()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture(options: { provider?: boolean; reviewed?: boolean } = {}) {
  const owner = createApplicationDraft({ id: 'consent' });
  owner.update(0, {
    fullName: 'Synthetic Person',
    currentCompany: 'Current',
    previousCompany: 'Previous',
    preference: 'remote',
    terms: true,
  });
  owner.upload(1, {
    name: 'resume.pdf',
    type: 'application/pdf',
    bytes: Buffer.from('actual bytes'),
  });
  const expected = owner.read();
  const gate = new ApprovalGate();
  const engine = new FakeEngine();
  let action: Record<string, unknown> = {};
  let generation = 1;
  let permitted = true;
  let generationCheck: (() => void) | undefined;
  let lostReturn = false;
  let afterConsume: (() => void) | undefined;
  const consume = gate.consumeReviewedApproval.bind(gate);
  vi.spyOn(gate, 'consumeReviewedApproval').mockImplementation(async (...args) => {
    const result = await consume(...args);
    if (result) afterConsume?.();
    return result;
  });
  const collect = vi.fn(async () => ({ application: owner.read(), document: 'fixed-document' }));
  const sourceId = randomUUID();
  const source = (): EvidenceReviewSource => ({
    ownerId: sourceId,
    contract: { id: 'synthetic-submission', version: '1' },
    permission: {
      generation,
      currentGeneration: () => {
        generationCheck?.();
        return generation;
      },
    },
    assertAuthorized() {
      if (!permitted) throw new Error('PRIVATE source denial');
    },
    collect,
  });
  const submit = {
    ...owner.submissionOperation,
    prepare(input: unknown) {
      const execute = owner.submissionOperation.prepare(input);
      return async (scope: Parameters<typeof execute>[0]) => {
        const result = await execute(scope);
        if (lostReturn && result.status === 'committed') throw new Error('Response lost');
        return result;
      };
    },
  };
  const provider = vi.fn<NonNullable<ServiceDependencies['evidenceReviewProvider']>>(() => ({
    action,
    source: source(),
  }));
  const service = new AgentBrowserService({
    engine,
    approvalGate: gate,
    applicationAdapters: [
      { ...owner.adapter, operations: { ...owner.adapter.operations, submit } },
    ],
    ...(options.provider === false ? {} : { evidenceReviewProvider: provider }),
  });
  services.push(service);
  const { sessionId } = await service.createSession({
    tenantId: 'owner',
    controlMode: 'delegated',
    ...(options.reviewed === false ? {} : { approval: { review: 'operator' as const } }),
  });
  service.applicationBind(sessionId, operator, { adapter: owner.adapter.id, resource: 'consent' });
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    const value = await service.authority.run(sessionId, operator, {}, fn);
    assert(!(value && typeof value === 'object' && 'replay' in value));
    return value as T;
  };
  const { pageId } = await run(() => service.createPage(sessionId));
  const raw = engine.getFakePage(engine.getSessionIds()[0] ?? '', pageId);
  assert(raw);
  raw.captureNativeForm = vi.fn(async () => {
    throw new Error('Unexpected native read');
  });
  // Internal C3b qualification only: public schemas do not yet carry approvalToken.
  const port = (service as unknown as { applicationAuthority: ApplicationAuthority })
    .applicationAuthority;
  const request: ApplicationRequest = {
    operation: 'submit',
    operationId: 'submit-once',
    expectedVersion: 2,
    input: { intent: 'submit', expected },
  };
  const signal = new AbortController().signal;
  const generate = async (overrideAction?: Record<string, unknown>) => {
    const token = await run(async () => {
      const prepared = overrideAction
        ? service.prepareEvidenceReviewInScope(sessionId, pageId, {
            action: overrideAction,
            source: source(),
          })
        : service.prepareApplicationSubmissionReviewInScope(sessionId, pageId, request, source());
      const result = await prepared.generate(signal);
      expect(
        service.authority.get(sessionId)?.operation(request.operationId ?? '')
      ).toBeUndefined();
      return result;
    });
    action = structuredClone(
      (token.action.parameters as { action: Record<string, unknown> }).action
    );
    return token;
  };
  const approve = (tokenId: string) =>
    run(() => service.decideApproval(sessionId, tokenId, 'approve'));
  const execute = (tokenId?: string, change: Partial<ApplicationRequest> = {}) =>
    port.execute(sessionId, operator, {
      ...request,
      ...change,
      ...(tokenId === undefined ? {} : { approvalToken: tokenId }),
    });
  return {
    owner,
    gate,
    service,
    port,
    run,
    pageId,
    sessionId,
    request,
    raw,
    source,
    collect,
    provider,
    generate,
    approve,
    execute,
    revoke() {
      generation++;
      permitted = false;
    },
    regrant() {
      generation++;
      permitted = true;
    },
    setAction(value: Record<string, unknown>) {
      action = value;
    },
    loseReturn() {
      lostReturn = true;
    },
    onGeneration(callback: () => void) {
      generationCheck = callback;
    },
    afterConsume(callback: () => void) {
      afterConsume = callback;
    },
  };
}

it('generates, approves and submits in separate admissions with one independent acceptance', async () => {
  const f = await fixture();
  const token = await f.generate();
  expect(token.status).toBe('pending');
  expect(f.owner.submissionCount()).toBe(0);
  await f.approve(token.tokenId);
  const accepted = await f.execute(token.tokenId);
  expect(accepted).toMatchObject({
    status: 'committed',
    value: { operationId: 'submit-once', intent: 'submit' },
  });
  expect(f.owner.submissionCount()).toBe(1);
  expect(f.owner.acceptedAttachment()).toEqual(Buffer.from('actual bytes'));
  expect(await f.service.applicationReceipt(f.sessionId, operator, 'submit-once')).toEqual(
    f.owner.receipt('submit-once')
  );
  const reads = f.collect.mock.calls.length;
  expect(await f.execute(token.tokenId)).toMatchObject({
    replay: true,
    operation: { status: 'completed', dispatched: true },
  });
  expect(f.collect).toHaveBeenCalledTimes(reads);
  expect(f.owner.submissionCount()).toBe(1);
  await expect(f.execute('changed-token')).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
});

it.each([
  'missing',
  'pending',
  'denied',
  'expired',
  'draft',
  'provider',
  'permission',
  'rebind',
  'page',
])('refuses %s consent before app dispatch', async (kind) => {
  const f = await fixture({ provider: kind !== 'provider' });
  const token = await f.generate(kind === 'draft' ? { intent: 'draft' } : undefined);
  if (kind !== 'pending' && kind !== 'provider') await f.approve(token.tokenId);
  if (kind === 'denied')
    await f.run(() => f.service.decideApproval(f.sessionId, token.tokenId, 'deny'));
  if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(token.expiresAt + 1);
  if (kind === 'permission') {
    f.revoke();
    f.regrant();
  }
  if (kind === 'rebind')
    f.service.applicationBind(f.sessionId, operator, {
      adapter: f.owner.adapter.id,
      resource: 'consent',
    });
  if (kind === 'page') await f.raw.close();
  await expect(f.execute(kind === 'missing' ? undefined : token.tokenId)).rejects.toBeDefined();
  expect(f.owner.submissionCount()).toBe(0);
  expect(f.service.authority.get(f.sessionId)?.operation('submit-once')).toMatchObject({
    dispatched: false,
    status: 'failed',
  });
});

it.each(['input', 'expectedVersion', 'operationId'])(
  'refuses a token/provider pair matching each other but not actual %s',
  async (field) => {
    const f = await fixture();
    const token = await f.generate();
    await f.approve(token.tokenId);
    const change =
      field === 'input'
        ? { input: { intent: 'submit', expected: { ...f.owner.read(), destination: 'other' } } }
        : field === 'expectedVersion'
          ? { expectedVersion: 3 }
          : { operationId: 'different' };
    const before = f.collect.mock.calls.length;
    await expect(f.execute(token.tokenId, change)).rejects.toBeDefined();
    expect(f.owner.submissionCount()).toBe(0);
    expect(f.collect).toHaveBeenCalledTimes(before);
  }
);

it('refuses after consumption if source permission is revoked and does not restore consent', async () => {
  const f = await fixture();
  const token = await f.generate();
  await f.approve(token.tokenId);
  f.afterConsume(() => {
    f.revoke();
    f.regrant();
  });
  await expect(f.execute(token.tokenId)).rejects.toBeDefined();
  expect(f.owner.submissionCount()).toBe(0);
  expect(f.service.authority.get(f.sessionId)?.operation('submit-once')).toMatchObject({
    dispatched: false,
  });
  const context = await f.run(async () => f.service.authority.reviewBindingInScope(f.sessionId));
  expect((await f.gate.getReviewedApproval(token.tokenId, context))?.status).toBe('used');
});

it('leaves a known app CAS rejection consumed and reconciles exact replay without another attempt', async () => {
  const f = await fixture();
  const token = await f.generate();
  await f.approve(token.tokenId);
  f.afterConsume(() => f.owner.update(2, { referral: 'external edit after last witness' }));
  expect(await f.execute(token.tokenId)).toEqual({
    status: 'rejected',
    reason: 'VERSION_CONFLICT',
  });
  expect(f.owner.submissionCount()).toBe(0);
  expect(await f.execute(token.tokenId)).toMatchObject({
    replay: true,
    operation: { status: 'failed', dispatched: true },
  });
});

it('reconciles a lost acceptance response through the existing independent receipt', async () => {
  const f = await fixture();
  const token = await f.generate();
  await f.approve(token.tokenId);
  f.loseReturn();
  await expect(f.execute(token.tokenId)).rejects.toThrow('Response lost');
  expect(f.service.authority.get(f.sessionId)?.operation('submit-once')).toMatchObject({
    status: 'outcome_unknown',
    dispatched: true,
  });
  expect(await f.service.applicationReceipt(f.sessionId, operator, 'submit-once')).toMatchObject({
    operationId: 'submit-once',
  });
  expect(await f.execute(token.tokenId)).toMatchObject({ replay: true });
  expect(f.owner.submissionCount()).toBe(1);
});

it('keeps public execute fail-closed and generation requires operator-review policy', async () => {
  const f = await fixture();
  const token = await f.generate();
  await f.approve(token.tokenId);
  await expect(
    f.service.applicationExecute(f.sessionId, operator, {
      ...f.request,
      approvalToken: token.tokenId,
    })
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(
    f.service.applicationExecute(f.sessionId, operator, f.request)
  ).rejects.toBeDefined();
  expect(f.owner.submissionCount()).toBe(0);
  const legacy = await fixture({ reviewed: false });
  await expect(legacy.generate()).rejects.toBeDefined();
  expect(legacy.owner.submissionCount()).toBe(0);
});

it('refuses an already consumed review even when no application operation was dispatched', async () => {
  const f = await fixture();
  const token = await f.generate();
  await f.approve(token.tokenId);
  expect(
    await f.run(() =>
      f.service
        .prepareApplicationSubmissionReviewInScope(f.sessionId, f.pageId, f.request, f.source())
        .consume(token.tokenId, new AbortController().signal)
    )
  ).toBe(true);
  await expect(f.execute(token.tokenId)).rejects.toBeDefined();
  expect(f.owner.submissionCount()).toBe(0);
});

it('rechecks review context after the async resolver returns before consuming consent', async () => {
  const f = await fixture();
  const token = await f.generate();
  await f.approve(token.tokenId);
  const context = await f.run(async () => f.service.authority.reviewBindingInScope(f.sessionId));
  f.provider.mockImplementationOnce(() => {
    queueMicrotask(() => f.service.authority.takeover(f.sessionId));
    return {
      action: (token.action.parameters as { action: Record<string, unknown> }).action,
      source: f.source(),
    };
  });
  await expect(f.execute(token.tokenId)).rejects.toBeDefined();
  expect(f.owner.submissionCount()).toBe(0);
  expect((await f.gate.getReviewedApproval(token.tokenId, context))?.status).toBe('approved');
});

it('retains admission until a cancelled evidence read drains', async () => {
  const f = await fixture();
  const token = await f.generate();
  await f.approve(token.tokenId);
  let started!: () => void;
  let finish!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const drain = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.collect.mockImplementationOnce(async () => {
    started();
    await drain;
    return { application: f.owner.read(), document: 'fixed-document' };
  });
  const execution = f.execute(token.tokenId);
  const refused = expect(execution).rejects.toBeDefined();
  await reading;
  try {
    f.service.authority.takeover(f.sessionId);
    expect(f.service.authority.get(f.sessionId)?.view().busy).toBe(true);
    expect(f.owner.submissionCount()).toBe(0);
  } finally {
    finish();
  }
  await refused;
  expect(f.service.authority.get(f.sessionId)?.view().busy).toBe(false);
  expect(f.owner.submissionCount()).toBe(0);
});

it('pins the original page after the last permission callback before allowing dispatch', async () => {
  const f = await fixture();
  const token = await f.generate();
  await f.approve(token.tokenId);
  await f.run(async () => {
    const review = f.port.prepareOperationReviewInScope(f.sessionId, f.request);
    const internal = f.service as unknown as {
      prepareApplicationConsent(
        review: PreparedApplicationOperationReview,
        tokenId: string
      ): PreparedApplicationConsent;
      pages: Map<string, unknown>;
    };
    const consent = internal.prepareApplicationConsent(review, token.tokenId);
    expect(await consent.consume()).toBe(true);
    let checks = 0;
    f.onGeneration(() => {
      if (++checks === 2) internal.pages.delete(f.pageId);
    });
    expect(() => consent.assertCurrent()).toThrow();
    expect(f.owner.submissionCount()).toBe(0);
  });
});
