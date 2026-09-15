import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

it('does not report verified success when an adapter ignores the fill option', async () => {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  try {
    const session = await service.createSession({ tenantId: 'owner' });
    const page = await service.createPage(session.sessionId);
    const native = engine.getFakePage(engine.getSessionIds()[0]!, page.pageId)!;
    native.seedElements([{ ref: 'field', role: 'textbox', name: 'Input' }]);
    const act = vi.spyOn(native, 'act');
    const observed = await service.observe(session.sessionId, page.pageId, {});
    const input = observed.elements.find((element) => element.role === 'textbox')!;
    await expect(
      service.act(session.sessionId, page.pageId, {
        action: 'fill',
        target: { ref: input.ref },
        value: 'once',
        expectValue: 'once',
      })
    ).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED', retryable: false });
    expect(act).toHaveBeenCalledOnce();
  } finally {
    await service.shutdown();
  }
});
