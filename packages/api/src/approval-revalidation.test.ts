/**
 * T5 B-dur-1 (B6): the act approval decision split into prepare / revalidate / commit.
 *
 * A durable browser operation decides BEFORE its marker (so an approval round trip never reaches
 * one), re-validates currency AFTER its storage wait without consuming, and consumes only after
 * the marker. These tests inject the wait between prepare and revalidate/commit and change the
 * approval source during it: every stale source is refused, nothing is dispatched, and a plain
 * act (prepare + commit back to back) is unchanged.
 */
import { ApprovalGate } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService, ServiceError } from './service.js';

type Plan = { revalidate(): Promise<void>; commit(): Promise<void> };
type Internals = {
  prepareApproval(
    sessionId: string,
    pageId: string,
    page: unknown,
    request: { action: string; target?: { ref: string }; approvalToken?: string },
    identity?: string
  ): Promise<Plan>;
  requirePage(sessionId: string, pageId: string): unknown;
};

async function fixture(
  gate: ApprovalGate,
  test: (scope: {
    service: AgentBrowserService;
    internals: Internals;
    sessionId: string;
    pageId: string;
    ref: string;
    dispatch: ReturnType<typeof vi.spyOn>;
  }) => Promise<void>
) {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({
    engine,
    approvalGate: gate,
    approvalPolicy: { unknownRisk: 'required' },
  });
  try {
    const { sessionId } = await service.createSession({ tenantId: 'fixture-owner' });
    const { pageId } = await service.createPage(sessionId);
    await service.navigate(sessionId, pageId, { url: 'https://example.com/application' });
    const engineId = engine.getSessionIds()[0];
    const page = engineId ? engine.getFakePage(engineId, pageId) : undefined;
    if (!page) throw new Error('Missing fake fixture page');
    page.setElements([{ role: 'button', name: 'Pay', risk: 'transaction' }]);
    const observation = await service.observe(sessionId, pageId, {});
    const ref = observation.elements[0]?.ref;
    if (!ref) throw new Error('Missing fixture target');
    await test({
      service,
      internals: service as unknown as Internals,
      sessionId,
      pageId,
      ref,
      dispatch: vi.spyOn(page, 'act'),
    });
  } finally {
    await service.shutdown();
  }
}

async function tokenFor(attempt: () => Promise<unknown>): Promise<string> {
  try {
    await attempt();
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'APPROVAL_REQUIRED')
      return error.details?.tokenId as string;
    throw error;
  }
  throw new Error('Expected APPROVAL_REQUIRED');
}

it('an approval round trip is decided at prepare: no token → APPROVAL_REQUIRED before any marker', async () => {
  await fixture(new ApprovalGate(), async ({ internals, sessionId, pageId, ref, dispatch }) => {
    await expect(
      internals.prepareApproval(sessionId, pageId, internals.requirePage(sessionId, pageId), {
        action: 'click',
        target: { ref },
      })
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

it('a token consumed during the wait fails revalidate and commit with a fresh APPROVAL_REQUIRED', async () => {
  const gate = new ApprovalGate();
  const generated = vi.spyOn(gate, 'generateApprovalToken');
  await fixture(gate, async ({ service, internals, sessionId, pageId, ref, dispatch }) => {
    const action = { action: 'click' as const, target: { ref } };
    const tokenId = await tokenFor(() => service.act(sessionId, pageId, action));
    // The token is bound to the target's resolved identity, which act passes in.
    const identity = (generated.mock.calls[0]?.[0] as { action: { identity?: string } } | undefined)
      ?.action.identity;
    const page = internals.requirePage(sessionId, pageId);
    const plan = await internals.prepareApproval(
      sessionId,
      pageId,
      page,
      { ...action, approvalToken: tokenId },
      identity
    );
    // Valid now, and revalidate does not burn it.
    await plan.revalidate();
    await plan.revalidate();
    // The injected wait: the same token is spent by a concurrent act.
    await service.act(sessionId, pageId, { ...action, approvalToken: tokenId });
    dispatch.mockClear();
    const stale = await plan.revalidate().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(stale).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect((stale as ServiceError).details?.tokenId).not.toBe(tokenId);
    await expect(plan.commit()).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

it('a plain act still decides and consumes at once (unchanged): one use, then refused', async () => {
  const gate = new ApprovalGate();
  await fixture(gate, async ({ service, sessionId, pageId, ref, dispatch }) => {
    const action = { action: 'click' as const, target: { ref } };
    const tokenId = await tokenFor(() => service.act(sessionId, pageId, action));
    await service.act(sessionId, pageId, { ...action, approvalToken: tokenId });
    expect(dispatch).toHaveBeenCalledTimes(1);
    // Re-observe (the act moved the revision) and try to reuse the spent token.
    const again = (await service.observe(sessionId, pageId, {})).elements[0]?.ref;
    if (!again) throw new Error('Missing target after re-observe');
    await expect(
      service.act(sessionId, pageId, {
        action: 'click',
        target: { ref: again },
        approvalToken: tokenId,
      })
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
