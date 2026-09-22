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

async function fixture(
  options: {
    provider?: boolean;
    reviewed?: boolean;
    publicProvider?: boolean;
    maxTokens?: number;
  } = {}
) {
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
  const gate = new ApprovalGate(options.maxTokens ? { maxTokens: options.maxTokens } : {});
  const engine = new FakeEngine();
  let action: Record<string, unknown> = {};
  let generation = 1;
  let permitted = true;
  let generationCheck: (() => void) | undefined;
  let lostReturn = false;
  let afterConsume: (() => void) | undefined;
  let onAuthorize: (() => void) | undefined;
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
  const provider = vi.fn<NonNullable<ServiceDependencies['evidenceReviewProvider']>>((routing) => {
    if (!options.publicProvider) return { action, source: source() };
    const application = routing.application;
    if (
      !application ||
      routing.identity.tenant !== 'owner' ||
      application.adapter !== owner.adapter.id ||
      application.resource !== 'consent' ||
      application.operation !== 'submit' ||
      routing.source.ownerId !== sourceId ||
      routing.source.contract.id !== 'synthetic-submission' ||
      routing.source.contract.version !== '1'
    )
      return undefined;
    const current = owner.read();
    return {
      action: {
        type: 'application-submit',
        intent: 'submit',
        tenant: routing.identity.tenant,
        sessionId: routing.identity.sessionId,
        sessionIncarnation: routing.identity.sessionIncarnation,
        ...application,
        expectedVersion: current.version,
        input: { intent: 'submit', expected: current },
      },
      source: source(),
    };
  });
  const service = new AgentBrowserService({
    engine,
    approvalGate: gate,
    applicationAdapters: [
      {
        ...owner.adapter,
        authorize(scope) {
          onAuthorize?.();
          return owner.adapter.authorize(scope);
        },
        operations: { ...owner.adapter.operations, submit },
      },
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
  // Retain direct authority coverage alongside the public service workflow below.
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
    onAuthorize(callback: () => void) {
      onAuthorize = callback;
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

it('keeps public execute fail-closed for invalid consent and requires operator-review policy', async () => {
  const f = await fixture();
  const token = await f.generate();
  await f.approve(token.tokenId);
  await expect(
    f.service.applicationExecute(f.sessionId, operator, {
      ...f.request,
      approvalToken: '',
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

function reviewBody(f: Awaited<ReturnType<typeof fixture>>, operationId = 'public-submit') {
  const source = f.source();
  return {
    pageId: f.pageId,
    source: { ownerId: source.ownerId, contract: source.contract },
    request: { ...f.request, operationId },
  };
}

it('creates two pending public reviews under one source owner without reserving execution', async () => {
  const f = await fixture({ publicProvider: true });
  const body = reviewBody(f);
  const first = await f.service.applicationReview(f.sessionId, operator, body);
  const second = await f.service.applicationReview(f.sessionId, operator, body);
  expect(first.status).toBe('pending');
  expect(second.status).toBe('pending');
  expect(first.tokenId).not.toBe(second.tokenId);
  expect(f.service.authority.get(f.sessionId)?.operation('public-submit')).toBeUndefined();
  expect(f.owner.submissionCount()).toBe(0);
  const third = await f.service.applicationReview(
    f.sessionId,
    operator,
    reviewBody(f, 'second-plan')
  );
  expect(third.status).toBe('pending');
  expect(f.provider.mock.calls.map(([routing]) => routing.application?.operationId)).toEqual([
    'public-submit',
    'public-submit',
    'second-plan',
  ]);
  for (const [routing] of f.provider.mock.calls) {
    expect(Object.keys(routing)).toEqual(['identity', 'source', 'application']);
    expect(routing.application).not.toHaveProperty('input');
    expect(routing).not.toHaveProperty('witness');
  }
  await f.approve(first.tokenId);
  expect(
    await f.service.applicationExecute(f.sessionId, operator, {
      ...body.request,
      approvalToken: first.tokenId,
    })
  ).toMatchObject({ status: 'committed' });
  expect(f.owner.submissionCount()).toBe(1);
  expect(
    await f.service.applicationExecute(f.sessionId, operator, {
      ...body.request,
      approvalToken: first.tokenId,
    })
  ).toMatchObject({ replay: true });
  await expect(
    f.service.applicationExecute(f.sessionId, operator, {
      ...body.request,
      approvalToken: second.tokenId,
    })
  ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
});

it.each(['source', 'operation', 'input', 'version', 'page', 'extra', 'token'] as const)(
  'refuses public review with changed %s and no application effects',
  async (change) => {
    const f = await fixture({ publicProvider: true });
    const body = reviewBody(f);
    if (change === 'source') body.source.ownerId = 'foreign-owner';
    if (change === 'operation') body.request.operation = 'read';
    if (change === 'input') body.request.input = { PRIVATE: 'not the complete payload' };
    if (change === 'version')
      body.request.expectedVersion = (body.request.expectedVersion ?? 0) + 1;
    if (change === 'page') body.pageId = 'foreign-page';
    if (change === 'extra') Object.assign(body, { PRIVATE: true });
    if (change === 'token') body.request.approvalToken = 'unapproved';
    await expect(f.service.applicationReview(f.sessionId, operator, body)).rejects.toThrow();
    expect(f.owner.submissionCount()).toBe(0);
    expect(f.service.authority.get(f.sessionId)?.operation('public-submit')).toBeUndefined();
  }
);

it('refuses public creation without configured source, review policy or current operator', async () => {
  for (const options of [{ provider: false }, { reviewed: false }]) {
    const f = await fixture({ ...options, publicProvider: true });
    await expect(
      f.service.applicationReview(f.sessionId, operator, reviewBody(f))
    ).rejects.toThrow();
    expect(f.owner.submissionCount()).toBe(0);
  }
  const f = await fixture({ publicProvider: true });
  await expect(
    f.service.applicationReview(f.sessionId, { ...operator, tenant: 'other' }, reviewBody(f))
  ).rejects.toThrow();
  expect(f.provider).not.toHaveBeenCalled();
});

it('rejects a provider that changes source identity and never allocates a token', async () => {
  const f = await fixture({ publicProvider: true });
  const resolve = f.provider.getMockImplementation();
  assert(resolve);
  f.provider.mockImplementation((routing) => {
    const configured = resolve(routing);
    assert(configured);
    return { ...configured, source: { ...configured.source, ownerId: 'different-owner' } };
  });
  const allocate = vi.spyOn(f.gate, 'generateReviewedApproval');
  await expect(f.service.applicationReview(f.sessionId, operator, reviewBody(f))).rejects.toThrow();
  expect(allocate).not.toHaveBeenCalled();
  expect(f.owner.submissionCount()).toBe(0);
});

it('rechecks the original application and page after provider reentry, including throwing callbacks', async () => {
  for (const throws of [false, true]) {
    const f = await fixture({ publicProvider: true });
    const resolve = f.provider.getMockImplementation();
    assert(resolve);
    f.provider.mockImplementation((routing) => {
      const result = resolve(routing);
      const pages = (f.service as unknown as { pages: Map<string, unknown> }).pages;
      pages.delete(f.pageId);
      if (throws) throw new Error('PRIVATE provider details');
      return result;
    });
    const allocate = vi.spyOn(f.gate, 'generateReviewedApproval');
    await expect(
      f.service.applicationReview(f.sessionId, operator, reviewBody(f))
    ).rejects.not.toThrow('PRIVATE');
    expect(allocate).not.toHaveBeenCalled();
  }
});

it('holds public creation admission while a cancelled source read drains', async () => {
  const f = await fixture({ publicProvider: true });
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
  const creation = f.service.applicationReview(f.sessionId, operator, reviewBody(f));
  const refused = expect(creation).rejects.toThrow();
  await reading;
  try {
    f.service.authority.takeover(f.sessionId);
    expect(f.service.authority.get(f.sessionId)?.view().busy).toBe(true);
  } finally {
    finish();
  }
  await refused;
  expect(f.service.authority.get(f.sessionId)?.view().busy).toBe(false);
  expect(f.owner.submissionCount()).toBe(0);
  expect(f.service.authority.get(f.sessionId)?.operation('public-submit')).toBeUndefined();
});

it('bounds inaccessible pending reviews through the existing approval quota', async () => {
  const f = await fixture({ publicProvider: true, maxTokens: 2 });
  await f.service.applicationReview(f.sessionId, operator, reviewBody(f));
  await f.service.applicationReview(f.sessionId, operator, reviewBody(f));
  await expect(f.service.applicationReview(f.sessionId, operator, reviewBody(f))).rejects.toThrow();
  expect(f.owner.submissionCount()).toBe(0);
  expect(f.service.authority.get(f.sessionId)?.operation('public-submit')).toBeUndefined();
});

it('detaches the complete public request before application authorization callbacks', async () => {
  const f = await fixture({ publicProvider: true });
  const body = reviewBody(f);
  const expectedSource = structuredClone(body.source);
  f.onAuthorize(() => {
    body.pageId = 'mutated-page';
    body.source.ownerId = 'mutated-source';
    body.request.operationId = 'mutated-operation';
  });
  const view = await f.service.applicationReview(f.sessionId, operator, body);
  expect(view.status).toBe('pending');
  expect(f.provider).toHaveBeenCalledWith(
    expect.objectContaining({
      identity: expect.objectContaining({ pageId: f.pageId }),
      source: expectedSource,
      application: expect.objectContaining({ operationId: 'public-submit' }),
    })
  );
  expect(f.owner.submissionCount()).toBe(0);
});

it('refuses review disclosure when the final application callback revokes evidence permission', async () => {
  const f = await fixture({ publicProvider: true });
  let generated = false;
  const composition = f.service as unknown as {
    prepareBoundEvidenceReview: (
      ...args: unknown[]
    ) => import('@agentbrowser/control').PreparedEvidenceReview;
  };
  const prepare = composition.prepareBoundEvidenceReview.bind(f.service);
  vi.spyOn(composition, 'prepareBoundEvidenceReview').mockImplementation((...args) => {
    const prepared = prepare(...args);
    return {
      ...prepared,
      async generate(signal) {
        const result = await prepared.generate(signal);
        generated = true;
        return result;
      },
    };
  });
  f.onAuthorize(() => {
    if (generated) f.revoke();
  });
  await expect(f.service.applicationReview(f.sessionId, operator, reviewBody(f))).rejects.toThrow();
  expect(generated).toBe(true);
  expect(f.owner.submissionCount()).toBe(0);
  expect(f.service.authority.get(f.sessionId)?.operation('public-submit')).toBeUndefined();
});
