import { ApprovalGate } from '@agentbrowser/core';
import type { EnginePage } from '@agentbrowser/engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService, type ServiceActRequest } from './service.js';

it('refuses coordinate input on an incapable engine, including the deprecated type alias', async () => {
  const service = new AgentBrowserService({
    engine: new FakeEngine(),
    approvalPolicy: { unknownRisk: 'allow' },
  });
  try {
    const { sessionId } = await service.createSession({});
    const { pageId } = await service.createPage(sessionId);
    for (const request of [{ action: 'clickAt' }, { type: 'clickAt' }])
      await expect(
        service.act(sessionId, pageId, { ...request, at: { unit: 'css', x: 10, y: 10 } } as never)
      ).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' });
  } finally {
    await service.shutdown();
  }
});
it.each(['legacy', 'delegated'])(
  'requires one-use approval in %s mode, binds coordinates/current authority and disposes every preparation',
  async (mode) => {
    const engine = new FakeEngine();
    const caps = await engine.capabilities();
    vi.spyOn(engine, 'capabilities').mockResolvedValue({ ...caps, coordinateInput: true });
    const gate = new ApprovalGate();
    const service = new AgentBrowserService({
      engine,
      approvalGate: gate,
      approvalPolicy: {
        unknownRisk: 'allow',
        rules: [{ action: 'clickAt', effect: 'read', decision: 'allow' }],
      },
    });
    const nativeInput = vi.fn();
    const dispose = vi.fn();
    try {
      const { sessionId } = await service.createSession({
        tenantId: 'owner',
        ...(mode === 'delegated' ? { controlMode: 'delegated' as const } : {}),
      });
      const { pageId } =
        mode === 'delegated'
          ? await service.authority.run(sessionId, { actor: 'operator', tenant: 'owner' }, {}, () =>
              service.createPage(sessionId)
            )
          : await service.createPage(sessionId);
      const delegate = () => {
        const review = service.authority.get(sessionId)!.prepareResume();
        return service.authority.authenticate(
          service.authority.delegate(sessionId, review.epoch, 'qa').token
        )!;
      };
      let agent = mode === 'delegated' ? delegate() : undefined;
      let sequence = 0;
      const runAct = (request: ServiceActRequest) =>
        agent
          ? service.authority.run(
              sessionId,
              agent,
              { id: `coordinate-${++sequence}`, fingerprint: `coordinate-${sequence}` },
              () => service.act(sessionId, pageId, request)
            )
          : service.act(sessionId, pageId, request);
      const page = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
      (page as EnginePage).prepareCoordinate = vi.fn(async () => ({
        identity: 'document:loader:point',
        token: {},
        dispose,
      }));
      const act = page.act.bind(page);
      vi.spyOn(page, 'act').mockImplementation(async (action) => {
        if (action.type !== 'clickAt') return act(action);
        (action.coordinateAssertCurrent as () => void)();
        await (action.coordinateBeforeDispatch as () => Promise<void>)();
        (action.coordinateAssertCurrent as () => void)();
        nativeInput();
        return {
          actionId: 'coordinate',
          startTimestamp: new Date().toISOString(),
          endTimestamp: new Date().toISOString(),
          oldRevision: 0,
          newRevision: 1,
          result: { dispatched: true, visibleEffect: 'none', warning: 'No visible effect' },
        };
      });
      const request = { action: 'clickAt', at: { unit: 'css', x: 10, y: 10 } } as const;
      const denied = await runAct(request).catch((e) => e);
      expect(denied).toMatchObject({ code: 'APPROVAL_REQUIRED' });
      expect(nativeInput).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
      let approvalToken = denied.details.tokenId;
      if (mode === 'delegated') {
        service.authority.takeover(sessionId);
        agent = delegate();
        // No page/revision/point/pixels changed and the old token is still unused.
        const staleApproval = await runAct({ ...request, approvalToken }).catch((e) => e);
        expect(staleApproval).toMatchObject({ code: 'APPROVAL_REQUIRED' });
        expect(nativeInput).not.toHaveBeenCalled();
        approvalToken = staleApproval.details.tokenId;
      }
      await expect(
        runAct({
          ...request,
          at: { unit: 'css', x: 11, y: 10 },
          approvalToken,
        })
      ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
      await runAct({ ...request, approvalToken });
      expect(nativeInput).toHaveBeenCalledOnce();
      await expect(runAct({ ...request, approvalToken })).rejects.toMatchObject({
        code: 'APPROVAL_REQUIRED',
      });
      expect(nativeInput).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledTimes(mode === 'delegated' ? 5 : 4);
    } finally {
      await service.shutdown();
    }
  }
);
