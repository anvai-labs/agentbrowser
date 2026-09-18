import {
  type ApplicationScope,
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
  it('blocks invalid verifier input before the plan and returns no private parser details', async () => {
    const read = vi.fn(() => true);
    const cleanup = vi.fn();
    const fixture = await serviceWith(sourceRegistry(read, cleanup));
    const execute = vi.spyOn(fixture.service, 'executePlan');
    const invalid = request();
    const input = { ...invalid, verification: { ...invalid.verification, input: 'PRIVATE-INPUT' } };
    try {
      const report = await fixture.service.executeOutcome(fixture.sessionId, fixture.pageId, input);
      expect(execute).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(report).toMatchObject({
        plan: { ok: false, completed: 0, results: [], error: { code: 'OUTCOME_NOT_EXECUTED' } },
        outcome: {
          availability: 'blocked',
          execution: 'not_started',
          verification: { status: 'unknown', evidenceRefIds: [] },
          cleanup: 'complete',
        },
      });
      expect(JSON.stringify(report)).not.toContain('PRIVATE');
      expect(JSON.stringify(report)).not.toContain('invalid fixture input');
    } finally {
      await fixture.service.shutdown();
    }
  });

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
  it.each(['match', 'missing-receipt', 'other-session', 'missing-correlation'] as const)(
    'correlates a business receipt under operator authority: %s',
    async (mode) => {
      const operator = { authorization: 'Bearer operator' };
      const tenant = 'fixture-tenant';
      const businessId = 'save-profile-42';
      const receipts = new Map<string, boolean>();
      const key = (
        scope: Pick<ApplicationScope, 'tenant' | 'resource' | 'sessionIncarnation'>,
        id: string
      ) => JSON.stringify([scope.tenant, scope.resource, scope.sessionIncarnation, id]);
      const receipt = vi.fn(async (scope: ApplicationScope, id: string) =>
        receipts.get(key(scope, id))
      );
      let application: AgentBrowserService['applicationAuthority'] | undefined;
      // Capture the service-owned authority only for trusted fixture composition.
      const originalCreate = AgentBrowserService.prototype.createSession;
      const create = vi
        .spyOn(AgentBrowserService.prototype, 'createSession')
        .mockImplementation(async function (this: AgentBrowserService, ...args) {
          application = this.applicationAuthority;
          return originalCreate.apply(this, args);
        });
      const execute = vi.spyOn(AgentBrowserService.prototype, 'executePlan');
      const cleanup = vi.fn();
      let server: Awaited<ReturnType<typeof buildServer>> | undefined;
      try {
        server = await buildServer({
          engine: new FakeEngine(),
          apiKeys: new Map([[createHash('sha256').update('operator').digest('hex'), tenant]]),
          applicationAdapters: [
            {
              id: 'fixture-app',
              authorize: (scope) => scope.tenant === tenant && scope.resource === 'profile',
              operations: {
                seed: {
                  mode: 'write',
                  prepare: () => async (scope) => {
                    if (!scope.operationId) throw new Error('Missing fixture operation ID');
                    receipts.set(key(scope, scope.operationId), true);
                    return { status: 'committed', value: true };
                  },
                },
              },
              receipt,
            },
          ],
          verifierRegistry: verifierRegistry(),
          evidenceSourceRegistry: new TrustedEvidenceSourceRegistry<ServiceOutcomeEvidenceContext>([
            defineEvidenceSource({
              descriptor: {
                id: 'fixture.snapshot',
                capability: 'fixture.read',
                correlation: 'required',
              },
              read: async (context, signal, correlationId) => {
                if (!application || !correlationId) throw new Error('Missing fixture setup');
                const evidence = await application.readReceiptInScope(
                  context.sessionId,
                  correlationId,
                  signal
                );
                return evidence === undefined
                  ? { status: 'pending' }
                  : { status: 'ready', evidence, evidenceRefIds: ['fixture_receipt_1'] };
              },
              cleanup,
            }),
          ]),
        });
        const firstSession = await server.inject({
          method: 'POST',
          url: '/v1/sessions',
          headers: operator,
          payload: { controlMode: 'delegated' },
        });
        expect(firstSession.statusCode).toBe(201);
        const ownerSession = firstSession.json().sessionId as string;
        const bind = async (id: string) => {
          if (!server) throw new Error('Missing fixture server');
          const result = await server.inject({
            method: 'PUT',
            url: `/v1/sessions/${id}/application`,
            headers: operator,
            payload: { adapter: 'fixture-app', resource: 'profile' },
          });
          expect(result.statusCode).toBe(200);
        };
        await bind(ownerSession);
        // Seed independently of the UI action: this qualifies receipt routing, not UI causality.
        const seeded = await server.inject({
          method: 'POST',
          url: `/v1/sessions/${ownerSession}/application/execute`,
          headers: operator,
          payload: { operation: 'seed', input: null, operationId: businessId, expectedVersion: 0 },
        });
        expect(seeded.statusCode).toBe(200);
        expect(seeded.json()).toEqual({ status: 'committed', value: true });
        let sessionId = ownerSession;
        if (mode === 'other-session') {
          const second = await server.inject({
            method: 'POST',
            url: '/v1/sessions',
            headers: operator,
            payload: { controlMode: 'delegated' },
          });
          expect(second.statusCode).toBe(201);
          sessionId = second.json().sessionId as string;
          await bind(sessionId);
          expect(sessionId).not.toBe(ownerSession);
        }
        const base = `/v1/sessions/${sessionId}`;
        const page = await server.inject({
          method: 'POST',
          url: `${base}/pages`,
          headers: { ...operator, 'x-agentbrowser-operation-id': 'create-page' },
        });
        expect(page.statusCode).toBe(201);
        const headers = {
          ...operator,
          'x-agentbrowser-operation-id': 'outcome-run-1',
        };
        const correlation = mode === 'missing-receipt' ? 'missing-receipt' : businessId;
        const payload = {
          ...request(),
          verification: {
            ...request().verification,
            ...(mode !== 'missing-correlation' ? { evidenceCorrelationId: correlation } : {}),
          },
        };
        const url = `${base}/pages/${page.json().pageId as string}/outcomes`;
        const response = await server.inject({ method: 'POST', url, headers, payload });
        expect(response.statusCode).toBe(200);
        expect(isPassingOutcome(response.json().outcome)).toBe(mode === 'match');
        expect(response.body).not.toContain(correlation);
        expect(cleanup).toHaveBeenCalledOnce();
        if (mode === 'missing-correlation') {
          expect(response.json().outcome).toMatchObject({
            availability: 'unsupported',
            execution: 'not_started',
          });
          expect(execute).not.toHaveBeenCalled();
          expect(receipt).not.toHaveBeenCalled();
        } else {
          expect(execute).toHaveBeenCalledOnce();
          expect(receipt).toHaveBeenCalledTimes(mode === 'match' ? 1 : 2);
          for (const [scope, id] of receipt.mock.calls) {
            expect(id).toBe(correlation);
            expect(scope).toMatchObject({ tenant, resource: 'profile', sessionId });
            expect(scope).not.toHaveProperty('operationId');
            expect(scope).not.toHaveProperty('bindingGeneration');
          }
          expect(response.json().outcome.verification.status).toBe(
            mode === 'match' ? 'passed' : 'unknown'
          );
        }
        const reads = receipt.mock.calls.length;
        const replay = await server.inject({ method: 'POST', url, headers, payload });
        expect(replay.json()).toMatchObject({
          replay: true,
          operation: { operationId: 'outcome-run-1', dispatched: mode !== 'missing-correlation' },
        });
        expect(receipt).toHaveBeenCalledTimes(reads);
        expect(cleanup).toHaveBeenCalledOnce();
        const changed = await server.inject({
          method: 'POST',
          url,
          headers,
          payload: {
            ...payload,
            verification: { ...payload.verification, evidenceCorrelationId: 'different-receipt' },
          },
        });
        expect(changed.statusCode).toBe(409);
        expect(receipt).toHaveBeenCalledTimes(reads);
        expect(execute).toHaveBeenCalledTimes(mode === 'missing-correlation' ? 0 : 1);
      } finally {
        create.mockRestore();
        execute.mockRestore();
        await server?.close();
      }
    }
  );

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

  it.each(['complete', 'takeover', 'invalid-input'] as const)(
    'preserves delegated operation identity with %s',
    async (mode) => {
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
          verification: {
            ...request().verification,
            input: mode === 'invalid-input' ? 'PRIVATE' : true,
          },
        };
        const url = `${base}/pages/${pageId}/outcomes`;

        expect(
          (await server.inject({ method: 'POST', url, headers: agent, payload })).statusCode
        ).toBe(400);
        const headers = { ...agent, 'x-agentbrowser-operation-id': 'verified-operation' };
        if (mode === 'takeover') {
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
        if (mode === 'invalid-input') {
          expect(first.statusCode).toBe(200);
          expect(first.json()).toMatchObject({
            plan: { ok: false, completed: 0, error: { code: 'OUTCOME_NOT_EXECUTED' } },
            outcome: {
              availability: 'blocked',
              execution: 'not_started',
              verification: { status: 'unknown', evidenceRefIds: [] },
            },
          });
          expect(first.body).not.toContain('PRIVATE');
          const replay = await server.inject({ method: 'POST', url, headers, payload });
          expect(replay.json()).toMatchObject({
            replay: true,
            operation: { status: 'failed', dispatched: false },
          });
          expect(reads).toBe(0);
          expect(cleanup).toHaveBeenCalledOnce();
          return;
        }
        if (mode === 'takeover') {
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
