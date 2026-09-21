import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService, type ServiceActRequest, ServiceError } from './service.js';

async function fixture(
  kind: 'fill' | 'select',
  test: (scope: {
    action: (value: string) => ServiceActRequest;
    approve: () => Promise<string>;
    execute: (request: ServiceActRequest) => Promise<unknown>;
    duringResolution: (mutate: () => void) => void;
    dispatch: ReturnType<typeof vi.spyOn>;
  }) => Promise<void>
) {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  try {
    const { sessionId } = await service.createSession({
      tenantId: 'owner',
      controlMode: 'delegated',
      approval: { review: 'operator', transactions: 'required' },
    });
    let sequence = 0;
    const run = async <T>(fn: () => Promise<T>): Promise<T> => {
      const id = `binding-race-${++sequence}`;
      const result = await service.authority.run(
        sessionId,
        { actor: 'operator', tenant: 'owner' },
        { id, fingerprint: id },
        fn
      );
      if (result && typeof result === 'object' && 'replay' in result)
        throw new Error('Unexpected fixture replay');
      return result as T;
    };
    const { pageId } = await run(() => service.createPage(sessionId));
    await run(() => service.navigate(sessionId, pageId, { url: 'https://example.com/review' }));
    const page = engine.getFakePage(engine.getSessionIds()[0]!, pageId)!;
    page.setElements([
      {
        role: kind === 'fill' ? 'textbox' : 'combobox',
        name: 'Synthetic reviewed field',
        risk: 'transaction',
      },
    ]);
    const observed = await run(() => service.observe(sessionId, pageId, {}));
    const ref = observed.elements[0]!.ref;
    const action = (value: string): ServiceActRequest => ({
      action: kind,
      target: { ref },
      ...(kind === 'fill' ? { value } : { values: [value] }),
    });
    const execute = (request: ServiceActRequest) =>
      run(() => service.act(sessionId, pageId, request));
    const approve = async () => {
      let tokenId: string | undefined;
      try {
        await execute(action('reviewed'));
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        expect(error.code).toBe('APPROVAL_REQUIRED');
        tokenId = error.details?.tokenId as string | undefined;
      }
      if (!tokenId) throw new Error('Missing fixture challenge');
      const challengeId = tokenId;
      await run(() => service.decideApproval(sessionId, challengeId, 'approve'));
      return challengeId;
    };
    const resolve = page.resolve.bind(page);
    await test({
      action,
      approve,
      execute,
      duringResolution: (mutate) => {
        vi.spyOn(page, 'resolve').mockImplementation(async (target) => {
          mutate();
          return resolve(target);
        });
      },
      dispatch: vi.spyOn(page, 'act'),
    });
  } finally {
    await service.shutdown();
  }
}

it.each(['fill', 'select'] as const)(
  'refuses unreviewed %s data even if the caller substitutes approved data during resolution',
  async (kind) => {
    await fixture(kind, async ({ action, approve, execute, duringResolution, dispatch }) => {
      const tokenId = await approve();
      const request = { ...action('unreviewed'), approvalToken: tokenId };
      duringResolution(() => {
        if (kind === 'fill') request.value = 'reviewed';
        else request.values![0] = 'reviewed';
      });
      await expect(execute(request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
      expect(dispatch).not.toHaveBeenCalled();
    });
  }
);

it.each(['fill', 'select'] as const)(
  'dispatches the captured approved %s data despite later caller mutation',
  async (kind) => {
    await fixture(kind, async ({ action, approve, execute, duringResolution, dispatch }) => {
      const tokenId = await approve();
      const request = { ...action('reviewed'), approvalToken: tokenId };
      duringResolution(() => {
        if (kind === 'fill') request.value = 'caller-changed';
        else request.values![0] = 'caller-changed';
      });
      await expect(execute(request)).resolves.toMatchObject({ status: 'success' });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining(kind === 'fill' ? { value: 'reviewed' } : { values: ['reviewed'] })
      );
    });
  }
);
