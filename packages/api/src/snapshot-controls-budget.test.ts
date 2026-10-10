import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it } from 'vitest';
import { AgentBrowserService } from './service';

/**
 * Round-13 invariants (TDD-first): controls=true is an ADDITIVE opt-in —
 * it must never make a snapshot that succeeded without it start failing.
 */
describe('snapshot controls budget invariants (round-13)', () => {
  it('BUDGET-1: an opt-in controls list never fails a snapshot that fits without it', async () => {
    const engine = new FakeEngine();
    const service = new AgentBrowserService({ engine });
    const session = await service.createSession({ tenantId: 't1' });
    const pageId = (await service.createPage(session.sessionId)).pageId;
    const esid = engine.getSessionIds()[0];
    const fp = engine.getFakePage(esid ?? '', pageId);
    if (!fp) throw new Error('no fake page');
    fp.seedElements([
      { ref: 'e1_0', role: 'button', name: 'A' },
      { ref: 'e1_1', role: 'button', name: 'B' },
      {
        ref: 'e1_2',
        role: 'control',
        name: 'Access: No access',
        context: 'Contents — Repository permissions',
        minted: true,
      },
      {
        ref: 'e1_3',
        role: 'control',
        name: 'Access: No access',
        context: 'Pull requests — Repository permissions',
        minted: true,
      },
    ]);

    // A tight budget the plain fields fit: must succeed without controls...
    const plain = await service.getSnapshot(session.sessionId, pageId, { maxBytes: 4000 });
    expect(plain.fields.length).toBeGreaterThanOrEqual(1);
    // ...and the SAME budget with controls=true must degrade (matched <
    // total), never throw OUTPUT_TRUNCATED.
    const withControls = await service.getSnapshot(session.sessionId, pageId, {
      controls: true,
      maxBytes: 4000,
    });
    expect(withControls.controlsProjection).toBeDefined();
    expect(withControls.controlsProjection?.total).toBe(2);
    await service.shutdown();
  });
});
