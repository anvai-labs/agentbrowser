/**
 * Compact-output increment 4: the act surface's keep-list, pinned.
 *
 * The REST act result is already compact by construction — ServiceActResult
 * carries only decision-relevant fields ({status, actionId, newRevision,
 * observation?, waitReason?, remap?, result?}); timestamps, fingerprints and
 * engine internals never reach the wire. This suite is the regression gate
 * that keeps it that way: a field added to the act response must be a
 * deliberate decision, not accretion.
 */
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it } from 'vitest';
import { AgentBrowserService } from './service';

/** Fields an agent needs to decide its next step; nothing else ships. */
const KEEP_LIST = new Set([
  'status',
  'actionId',
  'newRevision',
  'observation',
  'waitReason',
  'remap',
  'result',
]);

async function setup() {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  const session = await service.createSession({ tenantId: 't1' });
  const pageId = (await service.createPage(session.sessionId)).pageId;
  const engineSessionId = engine.getSessionIds()[0];
  if (engineSessionId === undefined) throw new Error('no engine session');
  const fakePage = engine.getFakePage(engineSessionId, pageId);
  if (!fakePage) throw new Error('no fake page');
  fakePage.seedElements([
    { ref: 'e1_0', role: 'textbox', name: 'First name', value: '' },
    { ref: 'e1_1', role: 'button', name: 'Apply' },
  ]);
  // Actions require a prior observation: refs are minted by observe.
  await service.observe(session.sessionId, pageId, {});
  return { service, session, pageId };
}

describe('act response shape (compact keep-list)', () => {
  it('carries only decision-relevant fields on success', async () => {
    const { service, session, pageId } = await setup();

    const result = (await service.act(session.sessionId, pageId, {
      action: 'click',
      target: { ref: 'e1_1' },
    })) as Record<string, unknown>;

    for (const key of Object.keys(result)) {
      expect(KEEP_LIST.has(key), `unexpected field on act result: ${key}`).toBe(true);
    }
    expect(result.status).toBe('success');
    expect(typeof result.actionId).toBe('string');
    expect(typeof result.newRevision).toBe('number');
  });

  it('publishes result evidence only for fill-verified and upload actions', async () => {
    const { service, session, pageId } = await setup();

    const plain = (await service.act(session.sessionId, pageId, {
      action: 'click',
      target: { ref: 'e1_1' },
    })) as Record<string, unknown>;
    expect(plain.result).toBeUndefined();

    // The click bumped the revision: re-observe to mint current refs before
    // the fill (ADR-004 — refs are only valid at their revision). An ordinary
    // fill publishes no result evidence at all (the typed value is private);
    // the verified/upload evidence paths are covered by real-chromium suites.
    const fresh = await service.observe(session.sessionId, pageId, {});
    const field = fresh.elements.find((e) => e.role === 'textbox');
    const filled = (await service.act(session.sessionId, pageId, {
      action: 'fill',
      target: { ref: field?.ref },
      value: 'sandbox value',
    })) as Record<string, unknown>;
    expect(filled.result).toBeUndefined();
    expect(filled.observation).toBeUndefined();
  });

  it('surfaces failures as typed error envelopes, never embedded in a 200 result', async () => {
    const { service, session, pageId } = await setup();

    const error = await service
      .act(session.sessionId, pageId, {
        action: 'click',
        target: { ref: 'e9_9' },
      })
      .catch((e: unknown) => e as { code?: string; message?: string });

    expect(error.code).toBeDefined();
    expect(error.message).toBeDefined();
  });

  it('keeps observe-after observations bounded to the interactive mode', async () => {
    const { service, session, pageId } = await setup();

    const result = (await service.act(session.sessionId, pageId, {
      action: 'click',
      target: { ref: 'e1_1' },
      observe: 'after',
    })) as { observation?: { elements?: unknown[]; status?: string } };

    expect(Array.isArray(result.observation?.elements)).toBe(true);
  });
});
