import {
  defineEvidenceSource,
  defineVerifier,
  TrustedEvidenceSourceRegistry,
  TrustedVerifierRegistry,
} from '@agentbrowser/control';
import { isPassingOutcome } from '@agentbrowser/protocol';
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentBrowserService,
  browserFailureOutcomeUnknown,
  browserReportOutcomeUnknown,
  type ServiceActResult,
  type ServiceBatchActResult,
  type ServiceOutcomeEvidenceContext,
} from './service';

const navigationObservation = {
  status: 'blocked',
  reason: 'egress_policy',
  scope: 'SCOPE_HOST_DENIED',
  observedDuring: 'action',
} as const;

async function fixture(
  registries: Partial<ConstructorParameters<typeof AgentBrowserService>[0]> = {}
) {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine, ...registries });
  const { sessionId } = await service.createSession({ tenantId: 'fixture-tenant' });
  const { pageId } = await service.createPage(sessionId);
  const engineSessionId = engine.getSessionIds()[0];
  if (!engineSessionId) throw new Error('Missing fixture session');
  const page = engine.getFakePage(engineSessionId, pageId);
  if (!page) throw new Error('Missing fixture page');
  page.setElements([{ role: 'button', name: 'Continue' }]);
  const state = await service.observe(sessionId, pageId, {});
  const ref = state.elements[0]?.ref;
  if (!ref) throw new Error('Missing fixture ref');
  const nativeAct = page.act.bind(page);
  const dispatch = vi.spyOn(page, 'act').mockImplementation(async (action) => ({
    ...(await nativeAct(action)),
    navigationObservation,
  }));
  return { service, sessionId, pageId, page, ref, dispatch, nativeAct };
}

describe('completed actions with observed scope navigation denials', () => {
  it('preserves the action receipt and skips follow-up waits and observations', async () => {
    const f = await fixture();
    const observe = vi.spyOn(f.service, 'observe').mockRejectedValue(new Error('post-read failed'));
    const wait = vi
      .spyOn(f.page, 'waitForLoadState')
      .mockRejectedValue(new Error('post-wait failed'));
    try {
      const result = (await f.service.act(f.sessionId, f.pageId, {
        action: 'click',
        target: { ref: f.ref },
        wait: { until: 'domcontentloaded', timeoutMs: 100 },
        observe: 'after',
      })) as ServiceActResult;
      expect(result).toMatchObject({ status: 'success', navigationObservation });
      expect(result.actionId).toEqual(expect.any(String));
      expect(result.newRevision).toBeGreaterThan(1);
      expect(result).not.toHaveProperty('waitReason');
      expect(result).not.toHaveProperty('observation');
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(wait).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
    } finally {
      await f.service.shutdown();
    }
  });

  it('counts the completed effect and stops before the next plan step without replay', async () => {
    const f = await fixture();
    try {
      const report = await f.service.executePlan(f.sessionId, f.pageId, [
        { action: 'click', target: { ref: f.ref } },
        { action: 'press', key: 'Tab' },
      ]);
      expect(report).toMatchObject({
        ok: false,
        completed: 1,
        results: [{ step: 0, ok: true, navigationObservation }],
        error: { code: 'PLAN_NAVIGATION_BLOCKED' },
      });
      expect(report.results).toHaveLength(1);
      expect(report.results[0]?.actionId).toEqual(expect.any(String));
      expect(report.results[0]).not.toHaveProperty('error');
      expect(f.dispatch).toHaveBeenCalledOnce();
    } finally {
      await f.service.shutdown();
    }
  });

  it('stops after the remap-success branch without replaying its effect', async () => {
    const f = await fixture();
    // Invalidate the service ref before the plan. Its stale preflight never dispatches;
    // the plan remaps once, then must stop on the successful action's observation.
    await f.service.act(f.sessionId, f.pageId, { action: 'press', key: 'Tab' });
    f.dispatch.mockClear();
    const observe = vi.spyOn(f.service, 'observe');
    try {
      const report = await f.service.executePlan(f.sessionId, f.pageId, [
        { action: 'click', target: { ref: f.ref } },
        { action: 'press', key: 'Tab' },
      ]);
      expect(report).toMatchObject({
        ok: false,
        completed: 1,
        results: [{ step: 0, ok: true, navigationObservation }],
        error: { code: 'PLAN_NAVIGATION_BLOCKED' },
      });
      expect(report.results).toHaveLength(1);
      expect(observe).toHaveBeenCalledOnce();
      expect(f.dispatch).toHaveBeenCalledOnce();
    } finally {
      await f.service.shutdown();
    }
  });

  it('retains the earlier completed prefix and counts the observed action once', async () => {
    const f = await fixture();
    f.dispatch.mockImplementationOnce(f.nativeAct);
    try {
      const report = await f.service.executePlan(f.sessionId, f.pageId, [
        { action: 'press', key: 'Tab' },
        { action: 'click', waitForLabel: 'Continue' },
        { action: 'press', key: 'Enter' },
      ]);
      expect(report).toMatchObject({
        ok: false,
        completed: 2,
        results: [
          { step: 0, ok: true },
          { step: 1, ok: true, navigationObservation },
        ],
        error: { code: 'PLAN_NAVIGATION_BLOCKED' },
      });
      expect(report.results).toHaveLength(2);
      expect(report.results[0]).not.toHaveProperty('navigationObservation');
      expect(f.dispatch).toHaveBeenCalledTimes(2);
    } finally {
      await f.service.shutdown();
    }
  });

  it('keeps an unverified fill outcome unknown despite observed navigation evidence', async () => {
    const f = await fixture();
    f.page.setElements([{ role: 'textbox', name: 'Name', value: '' }]);
    const state = await f.service.observe(f.sessionId, f.pageId, {});
    try {
      const failure = await f.service
        .act(f.sessionId, f.pageId, {
          action: 'fill',
          target: { ref: state.elements[0]?.ref },
          value: 'PRIVATE-FIXTURE-VALUE',
          expectValue: 'PRIVATE-FIXTURE-VALUE',
          remap: true,
        })
        .catch((error) => error);
      expect(failure).toMatchObject({ code: 'ENGINE_UNSUPPORTED', retryable: false });
      expect(failure.details).toEqual({ navigationObservation, actionId: expect.any(String) });
      expect(browserFailureOutcomeUnknown(failure)).toBe(true);
      expect(JSON.stringify(failure)).not.toContain('PRIVATE-FIXTURE-VALUE');
      expect(f.dispatch).toHaveBeenCalledOnce();
    } finally {
      await f.service.shutdown();
    }
  });

  it.each(['plan', 'batch'])(
    'stops an unverified fill in a %s as unknown without counting it as verified',
    async (mode) => {
      const f = await fixture();
      f.page.setElements([{ role: 'textbox', name: 'Name', value: '' }]);
      f.dispatch.mockImplementationOnce(f.nativeAct);
      const steps = [
        { action: 'press', key: 'Tab' },
        {
          action: 'fill',
          waitForLabel: 'Name',
          value: 'PRIVATE-FIXTURE-VALUE',
          expectValue: 'PRIVATE-FIXTURE-VALUE',
        },
        { action: 'press', key: 'Enter' },
      ];
      try {
        const report =
          mode === 'plan'
            ? await f.service.executePlan(f.sessionId, f.pageId, steps)
            : await f.service.act(f.sessionId, f.pageId, { steps });
        expect(report).toMatchObject({
          completed: 1,
          results: [
            { step: 0, ok: true },
            { step: 1, ok: false },
          ],
          error: {
            code: 'PLAN_STEP_FAILED',
            message: expect.stringContaining('fill may have completed'),
          },
        });
        expect(browserReportOutcomeUnknown(report)).toBe(true);
        expect(JSON.stringify(report)).not.toContain('PRIVATE-FIXTURE-VALUE');
        expect(f.dispatch).toHaveBeenCalledTimes(2);
      } finally {
        await f.service.shutdown();
      }
    }
  );

  it('retains successful verified-fill evidence with the bounded navigation observation', async () => {
    const f = await fixture();
    f.page.setElements([{ role: 'textbox', name: 'Name', value: '' }]);
    const state = await f.service.observe(f.sessionId, f.pageId, {});
    f.dispatch.mockImplementation(async (action) => ({
      ...(await f.nativeAct(action)),
      result: { verified: true },
      navigationObservation,
    }));
    try {
      const result = await f.service.act(f.sessionId, f.pageId, {
        action: 'fill',
        target: { ref: state.elements[0]?.ref },
        value: 'PRIVATE-FIXTURE-VALUE',
        expectValue: 'PRIVATE-FIXTURE-VALUE',
      });
      expect(result).toMatchObject({
        status: 'success',
        result: { verified: true },
        navigationObservation,
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE-FIXTURE-VALUE');
      expect(f.dispatch).toHaveBeenCalledOnce();
    } finally {
      await f.service.shutdown();
    }
  });

  it('reports batch failure with the completed receipt and skips batch follow-up work', async () => {
    const f = await fixture();
    const observe = vi.spyOn(f.service, 'observe').mockRejectedValue(new Error('post-read failed'));
    const wait = vi
      .spyOn(f.page, 'waitForLoadState')
      .mockRejectedValue(new Error('post-wait failed'));
    try {
      const result = (await f.service.act(f.sessionId, f.pageId, {
        steps: [
          { action: 'click', target: { ref: f.ref } },
          { action: 'press', key: 'Tab' },
        ],
        wait: { until: 'domcontentloaded', timeoutMs: 100 },
        observe: 'after',
      })) as ServiceBatchActResult;
      expect(result).toMatchObject({
        status: 'failed',
        completed: 1,
        results: [{ step: 0, ok: true, navigationObservation }],
        error: { code: 'PLAN_NAVIGATION_BLOCKED' },
      });
      expect(result.results).toHaveLength(1);
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(wait).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
    } finally {
      await f.service.shutdown();
    }
  });

  it('keeps the completed receipt in verified outcomes but never verifies or passes the stopped plan', async () => {
    const read = vi.fn(() => ({
      status: 'ready' as const,
      evidence: true,
      evidenceRefIds: ['fixture_evidence_1'],
    }));
    const verifier = defineVerifier({
      descriptor: {
        id: 'fixture.equals',
        version: '1.0.0',
        inputSchemaId: 'fixture.boolean',
        evidenceSchemaId: 'fixture.boolean',
        requiredCapability: 'fixture.read',
        evidenceSource: 'fixture.snapshot',
        requiredLayer: 'G4',
        budget: {
          maxReads: 1,
          timeoutMs: 100,
          pollIntervalMs: 5,
          cleanupTimeoutMs: 25,
          maxEvidenceRefs: 1,
        },
        redaction: 'reference_only',
        unsupported: [],
        cleanup: 'not_needed',
      },
      parseInput: (input: unknown) => input === true,
      parseEvidence: (evidence: unknown) => evidence === true,
      predicate: (input, evidence) => input === evidence,
    });
    const f = await fixture({
      verifierRegistry: new TrustedVerifierRegistry([verifier]),
      evidenceSourceRegistry: new TrustedEvidenceSourceRegistry<ServiceOutcomeEvidenceContext>([
        defineEvidenceSource({
          descriptor: { id: 'fixture.snapshot', capability: 'fixture.read' },
          read,
        }),
      ]),
    });
    try {
      const report = await f.service.executeOutcome(f.sessionId, f.pageId, {
        actions: [
          { action: 'click', target: { ref: f.ref } },
          { action: 'press', key: 'Tab' },
        ],
        verification: { verifier: { id: 'fixture.equals', version: '1.0.0' }, input: true },
      });
      expect(report).toMatchObject({
        plan: {
          ok: false,
          completed: 1,
          results: [{ step: 0, ok: true, navigationObservation }],
          error: { code: 'PLAN_NAVIGATION_BLOCKED' },
        },
        outcome: { execution: 'unknown', verification: { status: 'unknown' } },
      });
      expect(isPassingOutcome(report.outcome)).toBe(false);
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(read).not.toHaveBeenCalled();
    } finally {
      await f.service.shutdown();
    }
  });
});
