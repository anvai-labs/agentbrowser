import {
  TrustedEvidenceSourceRegistry,
  TrustedVerifierRegistry,
  defineEvidenceSource,
  defineVerifier,
} from '@agentbrowser/control';
import { isPassingOutcome } from '@agentbrowser/protocol';
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from './server';
import {
  AgentBrowserService,
  type ServiceError,
  type ServiceOutcomeEvidenceContext,
} from './service';

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
      maxReads: 2,
      timeoutMs: 100,
      pollIntervalMs: 5,
      cleanupTimeoutMs: 25,
      maxEvidenceRefs: 2,
    },
    redaction: 'reference_only',
    unsupported: [],
    cleanup: 'not_needed',
  },
  parseInput(input: unknown) {
    if (typeof input !== 'boolean') throw new Error('invalid fixture input');
    return input;
  },
  parseEvidence(evidence: unknown) {
    if (typeof evidence !== 'boolean') throw new Error('invalid fixture evidence');
    return evidence;
  },
  predicate: (input, evidence) => input === evidence,
});

const verifierRegistry = () => new TrustedVerifierRegistry([verifier]);
const sourceRegistry = (read: () => boolean = () => true, cleanup?: () => void | Promise<void>) =>
  new TrustedEvidenceSourceRegistry<ServiceOutcomeEvidenceContext>([
    defineEvidenceSource({
      descriptor: { id: 'fixture.snapshot', capability: 'fixture.read' },
      read: (_context: ServiceOutcomeEvidenceContext, _signal: AbortSignal) => ({
        status: 'ready' as const,
        evidence: read(),
        evidenceRefIds: ['fixture_evidence_1'],
      }),
      ...(cleanup ? { cleanup } : {}),
    }),
  ]);

const request = (id = 'fixture.equals') => ({
  actions: [{ action: 'press', key: 'Tab' }],
  verification: { verifier: { id, version: '1.0.0' }, input: true },
});

async function serviceWith(
  evidenceSourceRegistry = sourceRegistry()
): Promise<{ service: AgentBrowserService; sessionId: string; pageId: string }> {
  const service = new AgentBrowserService({
    engine: new FakeEngine(),
    verifierRegistry: verifierRegistry(),
    evidenceSourceRegistry,
  });
  const session = await service.createSession({ tenantId: 'fixture-tenant' });
  const page = await service.createPage(session.sessionId);
  return { service, sessionId: session.sessionId, pageId: page.pageId };
}

describe('verified outcome service composition', () => {
  it('withholds plan and evidence when the page closes during cleanup', async () => {
    let closePage: () => Promise<void> = async () => {};
    const cleanup = vi.fn(async () => {
      await closePage();
    });
    const fixture = await serviceWith(
      new TrustedEvidenceSourceRegistry<ServiceOutcomeEvidenceContext>([
        defineEvidenceSource({
          descriptor: { id: 'fixture.snapshot', capability: 'fixture.read' },
          read: () => ({
            status: 'ready',
            evidence: true,
            evidenceRefIds: ['fixture_evidence_1'],
          }),
          cleanup,
        }),
      ])
    );
    closePage = () => fixture.service.closePage(fixture.sessionId, fixture.pageId);
    const execute = vi.spyOn(fixture.service, 'executePlan');
    try {
      const report = await fixture.service.executeOutcome(
        fixture.sessionId,
        fixture.pageId,
        request()
      );
      expect(execute).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(isPassingOutcome(report.outcome)).toBe(false);
      expect(report).toMatchObject({
        plan: { ok: false, results: [], error: { code: 'OUTCOME_REPORT_UNAVAILABLE' } },
        outcome: {
          availability: 'blocked',
          execution: 'unknown',
          verification: { status: 'unknown', evidenceRefIds: [] },
          cleanup: 'complete',
        },
      });
    } finally {
      await fixture.service.shutdown();
    }
  });

  it('preflights an exact evidence capability before executing', async () => {
    const fixture = await serviceWith(new TrustedEvidenceSourceRegistry([]));
    const execute = vi.spyOn(fixture.service, 'executePlan');
    try {
      const report = await fixture.service.executeOutcome(
        fixture.sessionId,
        fixture.pageId,
        request()
      );
      expect(execute).not.toHaveBeenCalled();
      expect(report).toMatchObject({
        plan: { ok: false, completed: 0, results: [] },
        outcome: {
          availability: 'unsupported',
          execution: 'not_started',
          verification: { status: 'unknown' },
        },
      });
    } finally {
      await fixture.service.shutdown();
    }
  });

  it('rejects an unknown verifier without dispatching a plan', async () => {
    const fixture = await serviceWith();
    const execute = vi.spyOn(fixture.service, 'executePlan');
    try {
      await expect(
        fixture.service.executeOutcome(fixture.sessionId, fixture.pageId, request('unknown'))
      ).rejects.toMatchObject<ServiceError>({ code: 'INVALID_REQUEST' });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await fixture.service.shutdown();
    }
  });

  it('executes once and reads evidence only after completed execution', async () => {
    let reads = 0;
    const fixture = await serviceWith(
      sourceRegistry(() => {
        reads++;
        return true;
      })
    );
    const execute = vi.spyOn(fixture.service, 'executePlan').mockResolvedValue({
      ok: true,
      completed: 1,
      results: [{ step: 0, ok: true }],
      mode: 'stable',
      newRevision: 0,
    });
    try {
      const report = await fixture.service.executeOutcome(
        fixture.sessionId,
        fixture.pageId,
        request()
      );
      expect(execute).toHaveBeenCalledOnce();
      expect(reads).toBe(1);
      expect(report.outcome).toMatchObject({
        availability: 'available',
        execution: 'completed',
        verification: { status: 'passed', evidenceRefIds: ['fixture_evidence_1'] },
        testedSeam: 'ui',
      });
    } finally {
      await fixture.service.shutdown();
    }
  });

  it('does not read evidence after an execution failure', async () => {
    let reads = 0;
    const fixture = await serviceWith(
      sourceRegistry(() => {
        reads++;
        return true;
      })
    );
    vi.spyOn(fixture.service, 'executePlan').mockResolvedValue({
      ok: false,
      completed: 0,
      results: [],
      mode: 'stable',
      newRevision: 0,
      error: { code: 'PLAN_STEP_FAILED', message: 'fixture failure' },
    });
    try {
      const report = await fixture.service.executeOutcome(
        fixture.sessionId,
        fixture.pageId,
        request()
      );
      expect(reads).toBe(0);
      expect(report.outcome.execution).toBe('unknown');
      expect(report.outcome.verification.status).toBe('unknown');
    } finally {
      await fixture.service.shutdown();
    }
  });
});

describe('verified outcome REST projection', () => {
  it('exposes the same canonical report without an MCP dependency', async () => {
    const server = await buildServer({
      engine: new FakeEngine(),
      verifierRegistry: verifierRegistry(),
      evidenceSourceRegistry: sourceRegistry(),
    });
    try {
      const session = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: { tenantId: 'fixture-tenant' },
      });
      const sessionId = session.json().sessionId as string;
      const page = await server.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/pages` });
      const pageId = page.json().pageId as string;
      const response = await server.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/pages/${pageId}/outcomes`,
        payload: request(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        plan: { ok: true, completed: 1, results: [{ step: 0, ok: true }] },
        outcome: { execution: 'completed', verification: { status: 'passed' } },
      });
      expect(response.json()).not.toHaveProperty('pass');
      expect(response.json()).not.toHaveProperty('ok');
    } finally {
      await server.close();
    }
  });

  it.each([false, true])(
    'preserves delegated operation identity with cleanup takeover=%s',
    async (takeover) => {
      let reads = 0;
      let duringCleanup: () => Promise<void> = async () => {};
      const cleanup = vi.fn(() => duringCleanup());
      const apiKeys = new Map([
        [createHash('sha256').update('operator').digest('hex'), 'fixture-tenant'],
      ]);
      const server = await buildServer({
        engine: new FakeEngine(),
        apiKeys,
        verifierRegistry: verifierRegistry(),
        evidenceSourceRegistry: sourceRegistry(() => {
          reads++;
          return true;
        }, cleanup),
      });
      const operator = { authorization: 'Bearer operator' };
      try {
        const session = await server.inject({
          method: 'POST',
          url: '/v1/sessions',
          headers: operator,
          payload: { controlMode: 'delegated' },
        });
        const sessionId = session.json().sessionId as string;
        const base = `/v1/sessions/${sessionId}`;
        const page = await server.inject({
          method: 'POST',
          url: `${base}/pages`,
          headers: { ...operator, 'x-agentbrowser-operation-id': 'create-page' },
        });
        const pageId = page.json().pageId as string;
        const review = await server.inject({
          method: 'POST',
          url: `${base}/control/prepare-resume`,
          headers: operator,
        });
        const delegated = await server.inject({
          method: 'POST',
          url: `${base}/control/delegate`,
          headers: operator,
          payload: { epoch: review.json().epoch },
        });
        const agent = { authorization: `Bearer ${delegated.json().token as string}` };
        const payload = {
          ...request(),
          actions: [{ action: 'press', key: 'Tab' }],
        };
        const url = `${base}/pages/${pageId}/outcomes`;

        expect(
          (await server.inject({ method: 'POST', url, headers: agent, payload })).statusCode
        ).toBe(400);
        const headers = { ...agent, 'x-agentbrowser-operation-id': 'verified-operation' };
        if (takeover) {
          duringCleanup = async () => {
            const response = await server.inject({
              method: 'POST',
              url: `${base}/control/takeover`,
              headers: operator,
            });
            expect(response.statusCode).toBe(200);
          };
        }
        const first = await server.inject({ method: 'POST', url, headers, payload });
        expect(cleanup).toHaveBeenCalledOnce();
        if (takeover) {
          expect(first.statusCode).toBe(409);
          expect(first.json()).not.toHaveProperty('plan');
          expect(first.body).not.toContain('fixture_evidence_1');
          const status = await server.inject({
            url: `${base}/operations/verified-operation`,
            headers: operator,
          });
          expect(status.statusCode).toBe(200);
          expect(status.json()).toMatchObject({ status: 'outcome_unknown', dispatched: true });
          const revoked = await server.inject({ method: 'POST', url, headers, payload });
          expect(revoked.statusCode).not.toBe(200);
          expect(reads).toBe(1);
          expect(cleanup).toHaveBeenCalledOnce();
          return;
        }
        expect(first.statusCode).toBe(200);
        expect(first.json()).toMatchObject({
          plan: { ok: true, completed: 1 },
          outcome: { execution: 'completed', verification: { status: 'passed' } },
        });
        expect(reads).toBe(1);

        const replay = await server.inject({ method: 'POST', url, headers, payload });
        expect(replay.json()).toMatchObject({
          replay: true,
          operation: { status: 'completed', dispatched: true },
        });
        expect(reads).toBe(1);
      } finally {
        await server.close();
      }
    }
  );
});
import { createHash } from 'node:crypto';
