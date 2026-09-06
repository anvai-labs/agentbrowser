import { MetricsRegistry, SecretManager } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it } from 'vitest';
import { AgentBrowserService } from './service.js';

it('advances diff element cursors and honors explicit page size', async () => {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  try {
    const { sessionId } = await service.createSession({ tenantId: 'local' });
    const { pageId } = await service.createPage(sessionId);
    const engineId = engine.getSessionIds()[0];
    const page = engineId ? engine.getFakePage(engineId, pageId) : undefined;
    if (!page) throw new Error('Missing fake page');
    const baseline = await service.observe(sessionId, pageId, {});
    await service.act(sessionId, pageId, { action: 'reload' });
    page.setElements(
      Array.from({ length: 420 }, (_, index) => ({
        role: 'button',
        name: `Added button ${index}`,
      }))
    );
    const first = await service.observe(sessionId, pageId, { sinceRevision: baseline.revision });
    expect(first.elements).toHaveLength(300);
    expect(first.continuation?.nextOrdinal).toBe(300);
    const next = await service.observe(sessionId, pageId, {
      sinceRevision: baseline.revision,
      continueFrom: first.continuation?.nextOrdinal,
    });
    expect(next.elements).toHaveLength(120);
    expect(next.continuation).toBeUndefined();
    expect(new Set([...first.elements, ...next.elements].map((element) => element.name)).size).toBe(
      420
    );
    const full = await service.observe(sessionId, pageId, {
      sinceRevision: baseline.revision,
      maxElements: 1000,
    });
    expect(full.elements).toHaveLength(420);
    expect(full.continuation).toBeUndefined();
  } finally {
    await service.shutdown();
  }
});

it('paginates the full observation and budgets after expanding redaction', async () => {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({
    engine,
    secretManager: new SecretManager({ 'vault://short': 'q' }),
  });
  try {
    const { sessionId } = await service.createSession({ tenantId: 'local' });
    const { pageId } = await service.createPage(sessionId);
    const engineId = engine.getSessionIds()[0];
    const page = engineId ? engine.getFakePage(engineId, pageId) : undefined;
    if (!page) throw new Error('Missing fake page');
    page.setElements(
      Array.from({ length: 420 }, (_, index) => ({
        role: 'button',
        name: `${index} qqqqqqqqqq\u{1F642}`,
      }))
    );
    const first = await service.observe(sessionId, pageId, {});
    expect(first.elements).toHaveLength(300);
    const second = await service.observe(sessionId, pageId, {
      continueFrom: first.continuation?.nextOrdinal,
    });
    expect(second.elements).toHaveLength(120);
    expect(second.continuation).toBeUndefined();
    const budget = 1000;
    const bounded = await service.observe(sessionId, pageId, { maxBytes: budget });
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(budget);
    expect(bounded.elements[0]?.name).toContain('***');
    const next = await service.observe(sessionId, pageId, {
      maxBytes: budget,
      continueFrom: bounded.continuation?.nextOrdinal,
    });
    expect(next.elements[0]?.ref).not.toBe(bounded.elements[0]?.ref);
  } finally {
    await service.shutdown();
  }
});

it('bounds event bytes before replay and broadcast, isolates mutations, and counts drops/evictions', async () => {
  const engine = new FakeEngine();
  const metrics = new MetricsRegistry();
  const service = new AgentBrowserService({ engine, metrics });
  try {
    const { sessionId } = await service.createSession({ tenantId: 'local' });
    const { pageId } = await service.createPage(sessionId);
    const engineId = engine.getSessionIds()[0];
    const page = engineId ? engine.getFakePage(engineId, pageId) : undefined;
    if (!page) throw new Error('Missing fake page');
    let delivered = 0;
    service.subscribe(sessionId, (event) => {
      if (event.type === 'console.log') {
        delivered++;
        if (event.data) event.data.text = 'subscriber mutation';
      }
    });
    page.emitEvent('console.log', { text: 'x'.repeat(100_000) });
    for (let index = 0; index < 30; index++)
      page.emitEvent('console.log', { text: '\u{1F642}'.repeat(15_000), index });
    await expect.poll(() => delivered).toBe(30);
    const stats = service.getSessionEventStats(sessionId).other;
    expect(stats.bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(stats.dropped).toBe(1);
    expect(stats.evicted).toBeGreaterThan(0);
    expect(service.getSessionEvents(sessionId, 'console.log')[0]?.data?.text).not.toBe(
      'subscriber mutation'
    );
    expect(metrics.render()).toContain('events_dropped_total');
    expect(metrics.render()).toContain('events_evicted_total');
  } finally {
    await service.shutdown();
  }
});
