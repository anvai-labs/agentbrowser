import { createServer } from 'node:http';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { NetworkPolicy } from '@agentbrowser/policy';
import { expect, it } from 'vitest';
import { AgentBrowserService, ServiceError } from './service.js';

it('gates a real unannotated transaction and binds consent to its page', async () => {
  const fixture = createServer((_request, response) =>
    response.end('<button onclick="document.title=\'paid\'">Pay</button>')
  );
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const service = new AgentBrowserService({
    engine: new PlaywrightChromiumEngine(),
    networkPolicy: new NetworkPolicy(),
    approvalPolicy: {
      rules: [{ hostname: '127.0.0.1', action: 'click', name: 'Pay', effect: 'transaction' }],
    },
  });
  try {
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const { sessionId } = await service.createSession({ tenantId: 'local' });
    const pages = await Promise.all([service.createPage(sessionId), service.createPage(sessionId)]);
    const refs: string[] = [];
    for (const { pageId } of pages) {
      await service.navigate(sessionId, pageId, { url: `http://127.0.0.1:${address.port}/` });
      const ref = (await service.observe(sessionId, pageId, {})).elements.find(
        (element) => element.name === 'Pay'
      )?.ref;
      if (!ref) throw new Error('Missing Pay ref');
      refs.push(ref);
    }
    const first = pages[0];
    const second = pages[1];
    if (!first || !second || !refs[0] || !refs[1]) throw new Error('Missing pages');
    const action = { action: 'click', target: { ref: refs[0] } };
    let denial: ServiceError | undefined;
    try {
      await service.act(sessionId, first.pageId, action);
    } catch (error) {
      if (error instanceof ServiceError) denial = error;
      else throw error;
    }
    expect(denial?.code).toBe('APPROVAL_REQUIRED');
    const token = denial?.details?.tokenId;
    if (typeof token !== 'string') throw new Error('Missing approval token');
    expect((await service.observe(sessionId, first.pageId, {})).title).not.toBe('paid');
    await expect(
      service.act(sessionId, second.pageId, {
        ...action,
        target: { ref: refs[1] },
        approvalToken: token,
      })
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await service.act(sessionId, first.pageId, { ...action, approvalToken: token });
    expect((await service.observe(sessionId, first.pageId, {})).title).toBe('paid');
  } finally {
    await service.shutdown();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}, 30_000);
