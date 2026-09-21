import { ApprovalGate, type ApprovalRequest } from '@agentbrowser/core';
import { snapshotJsonData } from '@agentbrowser/protocol';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService, ServiceError } from './service.js';

async function fixture(
  gate: ApprovalGate,
  test: (scope: {
    service: AgentBrowserService;
    sessionId: string;
    pageId: string;
    ref: string;
    dispatch: ReturnType<typeof vi.spyOn>;
  }) => Promise<void>,
  role = 'button'
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
    page.setElements([{ role, name: 'Reviewed action', risk: 'transaction' }]);
    const observation = await service.observe(sessionId, pageId, {});
    const ref = observation.elements[0]?.ref;
    if (!ref) throw new Error('Missing fixture target');
    await test({ service, sessionId, pageId, ref, dispatch: vi.spyOn(page, 'act') });
  } finally {
    await service.shutdown();
  }
}

async function confirmationToken(attempt: () => Promise<unknown>): Promise<string> {
  try {
    await attempt();
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    expect(error.code).toBe('APPROVAL_REQUIRED');
    expect(error.details?.tokenId).toBeTypeOf('string');
    return error.details?.tokenId as string;
  }
  throw new Error('Expected a confirmation refusal');
}

it('does not dispatch when atomic consumption refuses despite an earlier valid preview', async () => {
  const gate = new ApprovalGate();
  // Model a gate whose preview is stale by the time consumption is attempted.
  // The service must use the authoritative consume result, not a prior preview.
  vi.spyOn(gate, 'validateApprovalToken').mockResolvedValue(true);
  vi.spyOn(gate, 'useApprovalToken').mockResolvedValue();
  const consume = vi.fn(async (_tokenId: string, _request: ApprovalRequest) => false);
  Object.assign(gate, { consumeApprovalToken: consume });
  await fixture(gate, async ({ service, sessionId, pageId, ref, dispatch }) => {
    const action = { action: 'click' as const, target: { ref } };
    const token = await confirmationToken(() => service.act(sessionId, pageId, action));
    expect(dispatch).not.toHaveBeenCalled();
    await expect(
      service.act(sessionId, pageId, { ...action, approvalToken: token })
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledTimes(1);
  });
});

it.each(['click', 'fill'] as const)(
  'keeps ordinary %s confirmation compatible with strict JSON binding and one use',
  async (action) => {
    const gate = new ApprovalGate();
    const issued = vi.spyOn(gate, 'generateApprovalToken');
    await fixture(
      gate,
      async ({ service, sessionId, pageId, ref, dispatch }) => {
        const request =
          action === 'fill'
            ? { action, target: { ref }, value: 'Synthetic fixture value' }
            : { action, target: { ref } };
        const token = await confirmationToken(() => service.act(sessionId, pageId, request));
        expect(dispatch).not.toHaveBeenCalled();
        const binding = issued.mock.calls[0]?.[0];
        expect(binding).toBeDefined();
        expect(
          snapshotJsonData(binding, { maxDepth: 16, maxNodes: 1000, maxBytes: 64 * 1024 })
        ).toEqual(binding);
        expect(binding?.action.parameters).not.toHaveProperty('approvalToken');
        expect(
          await service.act(sessionId, pageId, { ...request, approvalToken: token })
        ).toMatchObject({ status: 'success' });
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(await gate.getToken(token)).toMatchObject({ status: 'used' });

        const current = await service.observe(sessionId, pageId, {});
        const nextRef = current.elements[0]?.ref;
        if (!nextRef) throw new Error('Missing refreshed target');
        await expect(
          service.act(sessionId, pageId, {
            ...request,
            target: { ref: nextRef },
            approvalToken: token,
          })
        ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
        expect(dispatch).toHaveBeenCalledTimes(1);
      },
      action === 'fill' ? 'textbox' : 'button'
    );
  }
);
