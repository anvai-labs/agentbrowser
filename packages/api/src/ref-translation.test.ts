import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';

it('preserves source ordinals when prioritization reorders a large observation', async () => {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  try {
    const { sessionId } = await service.createSession({ tenantId: 'local' });
    const { pageId } = await service.createPage(sessionId);
    const engineId = engine.getSessionIds()[0];
    const page = engineId ? engine.getFakePage(engineId, pageId) : undefined;
    if (!page) throw new Error('Missing fake page');
    page.setElements([
      ...Array.from({ length: 305 }, (_, index) => ({ role: 'heading', name: `Heading ${index}` })),
      { role: 'textbox', name: 'Last input', value: '' },
    ]);
    const ref = (await service.observe(sessionId, pageId, {})).elements.find(
      (element) => element.name === 'Last input'
    )?.ref;
    if (!ref) throw new Error('Missing prioritized input');
    await service.act(sessionId, pageId, { action: 'fill', target: { ref }, value: 'right node' });
    expect(
      (await page.observe({})).elements.find((element) => element.name === 'Last input')?.value
    ).toBe('right node');
  } finally {
    await service.shutdown();
  }
});
