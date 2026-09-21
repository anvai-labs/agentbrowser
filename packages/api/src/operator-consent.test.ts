import { ApprovalGate, SecretManager } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService, type ServiceActRequest, ServiceError } from './service.js';

async function fixture(
  test: (f: {
    service: AgentBrowserService;
    gate: ApprovalGate;
    sessionId: string;
    pageId: string;
    action: ServiceActRequest;
    dispatch: ReturnType<typeof vi.spyOn>;
    run: <T>(fn: () => Promise<T>) => Promise<T>;
  }) => Promise<void>,
  transactions: 'required' | 'deny' = 'required'
) {
  const engine = new FakeEngine();
  const gate = new ApprovalGate();
  const service = new AgentBrowserService({
    engine,
    approvalGate: gate,
    secretManager: new SecretManager({ 'vault://private': 'BOUND-SECRET' }),
  });
  try {
    const { sessionId } = await service.createSession({
      tenantId: 'owner',
      controlMode: 'delegated',
      approval: { review: 'operator', transactions },
    });
    let seq = 0;
    const run = async <T>(fn: () => Promise<T>): Promise<T> => {
      const result = await service.authority.run(
        sessionId,
        { actor: 'operator', tenant: 'owner' },
        { id: `op-${++seq}`, fingerprint: `op-${seq}` },
        fn
      );
      if (result && typeof result === 'object' && 'replay' in result)
        throw new Error('Unexpected replay');
      return result as T;
    };
    const { pageId } = await run(() => service.createPage(sessionId));
    await run(() => service.navigate(sessionId, pageId, { url: 'https://example.com/settings' }));
    const page = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
    page.setElements([{ role: 'button', name: 'Synthetic save', risk: 'transaction' }]);
    const observed = await run(() => service.observe(sessionId, pageId, {}));
    const ref = observed.elements[0]!.ref;
    await test({
      service,
      gate,
      sessionId,
      pageId,
      action: { action: 'click', target: { ref } },
      dispatch: vi.spyOn(page, 'act'),
      run,
    });
  } finally {
    await service.shutdown();
  }
}

async function challenge(attempt: () => Promise<unknown>): Promise<string> {
  try {
    await attempt();
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    expect(error.code).toBe('APPROVAL_REQUIRED');
    expect(error.details?.tokenId).toBeTypeOf('string');
    return error.details?.tokenId as string;
  }
  throw new Error('Expected refusal');
}

it('does not dispatch a reviewed action by echoing a pending token', async () => {
  await fixture(async ({ service, sessionId, pageId, action, run, dispatch }) => {
    const token = await challenge(() => run(() => service.act(sessionId, pageId, action)));
    await challenge(() =>
      run(() => service.act(sessionId, pageId, { ...action, approvalToken: token }))
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
});

it('executes an explicitly approved action once and rejects a consumed token', async () => {
  await fixture(async ({ service, sessionId, pageId, action, run, dispatch }) => {
    const token = await challenge(() => run(() => service.act(sessionId, pageId, action)));
    const inspected = await run(() => service.getApproval(sessionId, token));
    expect(inspected).toMatchObject({ status: 'pending', action: { type: 'click', pageId } });
    await run(() => service.decideApproval(sessionId, token, 'approve'));
    expect(
      await run(() => service.act(sessionId, pageId, { ...action, approvalToken: token }))
    ).toMatchObject({ status: 'success' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await run(() => service.getApproval(sessionId, token))).toMatchObject({
      status: 'used',
    });
    await expect(run(() => service.decideApproval(sessionId, token, 'approve'))).rejects.toThrow();
  });
});

it.each(['takeover', 'configure', 'action'] as const)(
  'refuses approved action after %s drift',
  async (change) => {
    await fixture(async ({ service, sessionId, pageId, action, run, dispatch }) => {
      const token = await challenge(() => run(() => service.act(sessionId, pageId, action)));
      await run(() => service.decideApproval(sessionId, token, 'approve'));
      if (change === 'takeover') service.authority.takeover(sessionId);
      if (change === 'configure')
        service.authority.configure(sessionId, { actor: 'operator', tenant: 'owner' }, () => {});
      const changed =
        change === 'action' ? { ...action, action: 'press' as const, key: 'Enter' } : action;
      await challenge(() =>
        run(() => service.act(sessionId, pageId, { ...changed, approvalToken: token }))
      );
      expect(dispatch).not.toHaveBeenCalled();
    });
  }
);

it('does not weaken an explicit deny policy', async () => {
  await fixture(async ({ service, sessionId, pageId, action, run, dispatch }) => {
    await expect(run(() => service.act(sessionId, pageId, action))).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(dispatch).not.toHaveBeenCalled();
  }, 'deny');
});

it('refuses reviewed mode before allocating an uncontrolled browser session', async () => {
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const service = new AgentBrowserService({ engine });
  try {
    await expect(
      service.createSession({ tenantId: 'owner', approval: { review: 'operator' } })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(create).not.toHaveBeenCalled();
  } finally {
    await service.shutdown();
  }
});

it('refuses reviewed mode without a tenant before allocating a browser', async () => {
  const engine = new FakeEngine();
  const create = vi.spyOn(engine, 'createSession');
  const service = new AgentBrowserService({ engine });
  try {
    await expect(
      service.createSession({ controlMode: 'delegated', approval: { review: 'operator' } })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(create).not.toHaveBeenCalled();
  } finally {
    await service.shutdown();
  }
});

it.each(['vault://private', 'BOUND-SECRET'])(
  'refuses secret-bearing review without emitting or retaining it: %s',
  async (value) => {
    await fixture(async ({ service, gate, sessionId, pageId, action, run, dispatch }) => {
      await expect(
        run(() => service.act(sessionId, pageId, { ...action, action: 'fill', value }))
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ServiceError &&
          error.code === 'POLICY_DENIED' &&
          !JSON.stringify(error).includes('BOUND-SECRET')
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(gate.getTokenCount()).toBe(0);
    });
  }
);

it('never emits secret data even from an injected core record', async () => {
  await fixture(async ({ service, gate, sessionId, run }) => {
    const token = await run(() =>
      gate.generateReviewedApproval(
        { sessionId, action: { type: 'fill', value: 'BOUND-SECRET' } },
        service.authority.reviewBindingInScope(sessionId)
      )
    );
    for (const query of [
      () => service.getApproval(sessionId, token.tokenId),
      () => service.decideApproval(sessionId, token.tokenId, 'approve'),
    ]) {
      await expect(run(query)).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ServiceError &&
          error.code === 'POLICY_DENIED' &&
          !JSON.stringify(error).includes('BOUND-SECRET')
      );
    }
    expect(
      await run(() =>
        gate.getReviewedApproval(token.tokenId, service.authority.reviewBindingInScope(sessionId))
      )
    ).toMatchObject({ status: 'pending' });
  });
});

it('keeps explicitly allowed actions outside required approval and refuses direct approval queries', async () => {
  await fixture(async ({ service, gate, sessionId, pageId, run, dispatch }) => {
    expect(
      await run(() => service.act(sessionId, pageId, { action: 'scroll', deltaY: 1 }))
    ).toMatchObject({ status: 'success' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(gate.getTokenCount()).toBe(0);
    await expect(service.getApproval(sessionId, 'unknown')).rejects.toThrow();
  });
});

it('sanitizes exceptions during reviewed input capture before tracing starts', async () => {
  await fixture(async ({ service, sessionId, pageId, action, run, dispatch }) => {
    const input = new Proxy(action, {
      ownKeys() {
        throw new Error('BOUND-SECRET');
      },
    });
    await expect(run(() => service.act(sessionId, pageId, input))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ServiceError &&
        error.code === 'INVALID_REQUEST' &&
        !error.message.includes('BOUND-SECRET')
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
});
