import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';

const operator = { actor: 'operator' as const, tenant: 'owner' };
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture() {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  const { sessionId } = await service.createSession({
    tenantId: 'owner',
    controlMode: 'delegated',
  });
  const page = await service.authority.run(sessionId, operator, {}, () =>
    service.createPage(sessionId)
  );
  if ('replay' in page) throw new Error('Unexpected replay');
  const raw = engine.getFakePage(engine.getSessionIds()[0]!, page.pageId)!;
  const review = service.authority.get(sessionId)!.prepareResume();
  service.authority.delegate(sessionId, review.epoch);
  await drain();
  return { service, sessionId, raw };
}

it('keeps delegated contexts guarded after authority removal while preserving explicit legacy sessions', async () => {
  const { service, sessionId, raw } = await fixture();
  const received: unknown[] = [];
  service.subscribe(sessionId, (event) => received.push(event));
  try {
    raw.emitEvent('page.loaded', { phase: 'authorized' });
    await drain();
    expect(received).toHaveLength(1);
    service.authority.remove(sessionId);
    await expect(service.createPage(sessionId)).rejects.toThrow();
    raw.emitEvent('page.loaded', { phase: 'removed owner' });
    await raw.close();
    await drain();
    expect(received).toHaveLength(1);
    expect(service.getSessionEvents(sessionId)).toHaveLength(1);
    const legacy = await service.createSession({ tenantId: 'owner' });
    expect((await service.createPage(legacy.sessionId)).pageId).toBeTruthy();
    await service.closeSession(legacy.sessionId);
  } finally {
    await service.closeSession(sessionId);
  }
});

it('rechecks authority between event subscribers when the first one takes over', async () => {
  const { service, sessionId, raw } = await fixture();
  const first: unknown[] = [];
  const second: unknown[] = [];
  service.subscribe(sessionId, (event) => {
    first.push(event);
    service.authority.takeover(sessionId);
  });
  service.subscribe(sessionId, (event) => second.push(event));
  try {
    raw.emitEvent('page.loaded', { phase: 'before takeover' });
    await drain();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  } finally {
    await service.closeSession(sessionId);
  }
});
