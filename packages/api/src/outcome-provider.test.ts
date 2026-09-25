import { createHash } from 'node:crypto';
import { setImmediate as settlePublication } from 'node:timers/promises';
import {
  type ApplicationReceiptAuthorizationRequest,
  type ApplicationScope,
  TrustedEvidenceSourceRegistry,
  TrustedVerifierRegistry,
  defineVerifier,
} from '@agentbrowser/control';
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import {
  AgentBrowserService,
  type ServiceEvidenceSourceBuilder,
  type ServiceOutcomeEvidenceContext,
} from './service.js';

const registry = () => new TrustedEvidenceSourceRegistry<ServiceOutcomeEvidenceContext>();

describe('lazy service evidence-source composition', () => {
  it('invokes one frozen narrow builder after constructing application authority', async () => {
    let captured: ServiceEvidenceSourceBuilder | undefined;
    const provider = vi.fn((sources: ServiceEvidenceSourceBuilder) => {
      captured = sources;
      return registry();
    });
    const service = new AgentBrowserService({
      engine: new FakeEngine(),
      evidenceSourceRegistryProvider: provider,
    });
    try {
      expect(provider).toHaveBeenCalledOnce();
      expect(Object.isFrozen(captured)).toBe(true);
      expect(Object.keys(captured ?? {})).toEqual(['applicationReceipt', 'applicationRead']);
      expect(typeof captured?.applicationReceipt).toBe('function');
      expect(typeof captured?.applicationRead).toBe('function');
      expect(service.applicationAuthority).toBeDefined();
    } finally {
      await service.shutdown();
    }
  });

  it('reads the service-owned binding within one admission and refuses another verifier', async () => {
    const principal = { actor: 'operator' as const, tenant: 'fixture-tenant' };
    const input = { key: 'setting' };
    const execute = vi.fn(async (scope: ApplicationScope) => ({
      status: 'read' as const,
      value: { resource: scope.resource, setting: 'saved' },
    }));
    const prepare = vi.fn((candidate: unknown) => {
      expect(candidate).toEqual(input);
      return execute;
    });
    let captured: TrustedEvidenceSourceRegistry<ServiceOutcomeEvidenceContext> | undefined;
    const service = new AgentBrowserService({
      engine: new FakeEngine(),
      applicationAdapters: [
        {
          id: 'fixture-app',
          authorize: (scope) => scope.tenant === principal.tenant && scope.resource === 'settings',
          operations: { state: { mode: 'read', prepare } },
          receipt: async () => undefined,
        },
      ],
      evidenceSourceRegistryProvider: (sources) => {
        captured = new TrustedEvidenceSourceRegistry([
          sources.applicationRead({
            descriptor: { id: 'fixture.state', capability: 'setting.matches' },
            request: { operation: 'state', input },
            authorize: (request) => {
              expect(Object.isFrozen(request.identity)).toBe(true);
              expect(request.identity).toMatchObject({
                adapter: 'fixture-app',
                resource: 'settings',
                operation: 'state',
                admission: principal,
              });
              expect(request).not.toHaveProperty('context');
              if (request.verifier.id !== 'setting.matches' || request.verifier.version !== '1')
                return undefined;
              return { generation: 1, currentGeneration: () => 1 };
            },
            evidenceRefs: () => ['setting-receipt'],
          }),
        ]);
        return captured;
      },
    });
    try {
      const session = await service.createSession({
        tenantId: principal.tenant,
        controlMode: 'delegated',
      });
      service.applicationBind(session.sessionId, principal, {
        adapter: 'fixture-app',
        resource: 'settings',
      });
      if (!captured) throw new Error('Missing fixture source registry');
      const sources = captured;
      const signal = new AbortController().signal;
      const context = { sessionId: session.sessionId, pageId: 'fixture-page', signal };
      const admission = vi.spyOn(service.authority, 'run');
      await service.authority.run(session.sessionId, principal, {}, async () => {
        const read = sources.prepareRead(
          'fixture.state',
          'setting.matches',
          context,
          'correlation',
          {
            id: 'setting.matches',
            version: '1',
            input: { expected: 'saved' },
          }
        );
        expect(read).toBeDefined();
        if (!read) throw new Error('Missing fixture read');
        expect(await read(signal)).toEqual({
          status: 'ready',
          evidence: { resource: 'settings', setting: 'saved' },
          evidenceRefIds: ['setting-receipt'],
        });
        expect(() =>
          sources.prepareRead('fixture.state', 'setting.matches', context, 'correlation', {
            id: 'another.verifier',
            version: '1',
            input: { expected: 'saved' },
          })
        ).toThrow('Evidence authorization unavailable');
      });
      expect(admission).toHaveBeenCalledOnce();
      expect(prepare).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      await service.shutdown();
    }
  });

  it('rejects ambiguous or invalid provider configuration without invoking extra factories', () => {
    const direct = registry();
    const ambiguous = vi.fn(() => registry());
    expect(
      () =>
        new AgentBrowserService({
          engine: new FakeEngine(),
          evidenceSourceRegistry: direct,
          evidenceSourceRegistryProvider: ambiguous,
        })
    ).toThrow('mutually exclusive');
    expect(ambiguous).not.toHaveBeenCalled();

    for (const provider of [
      vi.fn(() => ({}) as never),
      vi.fn(() => {
        throw new Error('PRIVATE-PROVIDER');
      }),
    ]) {
      expect(
        () =>
          new AgentBrowserService({
            engine: new FakeEngine(),
            evidenceSourceRegistryProvider: provider,
          })
      ).toThrow();
      expect(provider).toHaveBeenCalledOnce();
    }
  });

  it.each([null, false, 0])('rejects explicitly supplied invalid provider %s', (value) => {
    expect(
      () =>
        new AgentBrowserService({
          engine: new FakeEngine(),
          evidenceSourceRegistryProvider: value as never,
        })
    ).toThrow();
  });

  it('fails before allocating owned background resources and consumes rejected async providers', async () => {
    const timer = vi.spyOn(globalThis, 'setInterval');
    try {
      for (const provider of [
        () => {
          throw new Error('private');
        },
        () => Promise.reject(new Error('private')),
        () => ({
          // biome-ignore lint/suspicious/noThenProperty: intentionally malformed asynchronous provider fixture.
          then: (_resolve: unknown, reject: (error: Error) => void) => reject(new Error('private')),
        }),
      ]) {
        expect(
          () =>
            new AgentBrowserService({
              engine: new FakeEngine(),
              evidenceSourceRegistryProvider: provider as never,
            })
        ).toThrow();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });

  it('passes the provider through the HTTP composition root exactly once', async () => {
    const provider = vi.fn(() => registry());
    const server = await buildServer({
      engine: new FakeEngine(),
      evidenceSourceRegistryProvider: provider,
    });
    try {
      expect(provider).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
});

// Receipts are seeded independently: this tests scoped observation, not UI causality.
describe('application-scoped permission through delegated HTTP outcomes', () => {
  it.each(['parallel', 'denied', 'wrong-mode', 'revoked-read'] as const)(
    'qualifies %s without expanding raw application permissions',
    async (mode) => {
      const denied = mode === 'denied' || mode === 'wrong-mode';
      const operator = { authorization: 'Bearer operator' };
      const tenant = 'fixture-tenant';
      const grants = new Map<string, { resource: string; incarnation: string; value: number }>();
      const receipts = new Map<string, number>();
      const key = (scope: ApplicationScope, id: string) =>
        JSON.stringify([scope.tenant, scope.resource, scope.sessionIncarnation, id]);
      let generation = 1;
      let entered = 0;
      let release!: () => void;
      const together = new Promise<void>((resolve) => {
        release = resolve;
      });
      const receipt = vi.fn(async (scope: ApplicationScope, id: string) => {
        if (mode === 'parallel') {
          if (++entered === 2) release();
          await together;
        }
        if (mode === 'revoked-read') generation++;
        return receipts.get(key(scope, id));
      });
      const authorize = vi.fn((request: ApplicationReceiptAuthorizationRequest) => {
        const grant = grants.get(request.identity.sessionId);
        if (
          mode === 'denied' ||
          !grant ||
          request.source.id !== 'fixture.receipt' ||
          request.source.capability !== 'receipt.equals' ||
          request.verifier.id !== 'receipt.equals' ||
          request.verifier.version !== '1' ||
          request.verifier.input !== grant.value ||
          request.correlationId !== 'shared-business' ||
          request.identity.admission.actor !== 'agent' ||
          request.identity.admission.mode !== 'qa' ||
          request.identity.admission.tenant !== tenant ||
          request.identity.adapter !== 'fixture-app' ||
          request.identity.resource !== grant.resource ||
          request.identity.sessionIncarnation !== grant.incarnation
        )
          return undefined;
        return { generation, currentGeneration: () => generation };
      });
      const execute = vi.spyOn(AgentBrowserService.prototype, 'executePlan');
      const server = await buildServer({
        engine: new FakeEngine(),
        apiKeys: new Map([[createHash('sha256').update('operator').digest('hex'), tenant]]),
        applicationAdapters: [
          {
            id: 'fixture-app',
            authorize: (scope) =>
              scope.tenant === tenant && ['resource-a', 'resource-b'].includes(scope.resource),
            operations: {
              seed: {
                mode: 'write',
                prepare: (input) => async (scope) => {
                  if (typeof input !== 'number' || !scope.operationId)
                    throw new Error('Invalid fixture');
                  grants.set(scope.sessionId, {
                    resource: scope.resource,
                    incarnation: scope.sessionIncarnation,
                    value: input,
                  });
                  receipts.set(key(scope, scope.operationId), input);
                  return { status: 'committed', value: input };
                },
              },
            },
            receipt,
          },
        ],
        verifierRegistry: new TrustedVerifierRegistry([
          defineVerifier({
            descriptor: {
              id: 'receipt.equals',
              version: '1',
              inputSchemaId: 'number',
              evidenceSchemaId: 'number',
              requiredCapability: 'receipt.equals',
              evidenceSource: 'fixture.receipt',
              requiredLayer: 'G4',
              budget: {
                maxReads: 1,
                timeoutMs: 500,
                pollIntervalMs: 1,
                cleanupTimeoutMs: 25,
                maxEvidenceRefs: 1,
              },
              redaction: 'reference_only',
              unsupported: [],
              cleanup: 'not_needed',
            },
            parseInput: (input) => {
              if (typeof input !== 'number') throw new Error();
              return input;
            },
            parseEvidence: (input) => {
              if (typeof input !== 'number') throw new Error();
              return input;
            },
            predicate: (a, b) => a === b,
          }),
        ]),
        evidenceSourceRegistryProvider: (sources) =>
          new TrustedEvidenceSourceRegistry([
            sources.applicationReceipt({
              descriptor: { id: 'fixture.receipt', capability: 'receipt.equals' },
              authorize,
              evidenceRefs: () => ['fixture-receipt'],
            }),
          ]),
      });
      const setup = async (resource: string, value: number) => {
        const session = await server.inject({
          method: 'POST',
          url: '/v1/sessions',
          headers: operator,
          payload: { controlMode: 'delegated' },
        });
        expect(session.statusCode).toBe(201);
        const sessionId = session.json().sessionId as string;
        const base = `/v1/sessions/${sessionId}`;
        expect(
          (
            await server.inject({
              method: 'PUT',
              url: `${base}/application`,
              headers: operator,
              payload: { adapter: 'fixture-app', resource },
            })
          ).statusCode
        ).toBe(200);
        expect(
          (
            await server.inject({
              method: 'POST',
              url: `${base}/application/execute`,
              headers: operator,
              payload: {
                operation: 'seed',
                input: value,
                operationId: 'shared-business',
                expectedVersion: 0,
              },
            })
          ).statusCode
        ).toBe(200);
        // inject resolves at response finish before publication's release continuation.
        await settlePublication();
        const page = await server.inject({
          method: 'POST',
          url: `${base}/pages`,
          headers: { ...operator, 'x-agentbrowser-operation-id': 'page' },
        });
        expect(page.statusCode).toBe(201);
        await settlePublication();
        const review = await server.inject({
          method: 'POST',
          url: `${base}/control/prepare-resume`,
          headers: operator,
        });
        expect(review.statusCode).toBe(200);
        await settlePublication();
        const delegate = await server.inject({
          method: 'POST',
          url: `${base}/control/delegate`,
          headers: operator,
          payload: { epoch: review.json().epoch, mode: mode === 'wrong-mode' ? 'forms' : 'qa' },
        });
        expect(delegate.statusCode).toBe(200);
        await settlePublication();
        const headers = {
          authorization: `Bearer ${delegate.json().token as string}`,
          'x-agentbrowser-operation-id': 'outcome',
        };
        return {
          base,
          sessionId,
          headers,
          url: `${base}/pages/${page.json().pageId as string}/outcomes`,
          payload: {
            actions: [{ action: 'press', key: 'Tab' }],
            verification: {
              verifier: { id: 'receipt.equals', version: '1' },
              input: value,
              evidenceCorrelationId: 'shared-business',
            },
          },
        };
      };
      try {
        const sessions = [await setup('resource-a', 1)];
        if (mode === 'parallel') sessions.push(await setup('resource-b', 2));
        const reports = await Promise.all(
          sessions.map(({ url, headers, payload }) =>
            server.inject({ method: 'POST', url, headers, payload })
          )
        );
        for (const [index, report] of reports.entries()) {
          const session = sessions[index]!;
          expect(report.statusCode).toBe(200);
          if (mode === 'parallel')
            expect(report.json().outcome).toMatchObject({
              availability: 'available',
              execution: 'completed',
              verification: { status: 'passed', evidenceRefIds: ['fixture-receipt'] },
            });
          else
            expect(report.json().outcome).toMatchObject({
              availability: 'blocked',
              execution: denied ? 'not_started' : 'unknown',
              verification: { status: 'unknown', evidenceRefIds: [] },
            });
          const replay = await server.inject({
            method: 'POST',
            url: session.url,
            headers: session.headers,
            payload: session.payload,
          });
          const status = mode === 'parallel' ? 'completed' : denied ? 'failed' : 'outcome_unknown';
          expect(replay.statusCode).toBe(200);
          expect(replay.json()).toMatchObject({
            replay: true,
            operation: { status, dispatched: !denied },
          });
          // Observing an approved predicate does not grant this QA token raw receipt access.
          const raw = await server.inject({
            url: `${session.base}/application/receipts/shared-business`,
            headers: session.headers,
          });
          expect(raw.statusCode).toBe(403);
        }
        expect(authorize).toHaveBeenCalledTimes(sessions.length);
        expect(execute).toHaveBeenCalledTimes(denied ? 0 : sessions.length);
        expect(receipt).toHaveBeenCalledTimes(denied ? 0 : sessions.length);
        for (const [request] of authorize.mock.calls) {
          expect(request).not.toHaveProperty('context');
          expect(request).not.toHaveProperty('read');
          expect(Object.isFrozen(request.identity.admission)).toBe(true);
        }
      } finally {
        release();
        execute.mockRestore();
        await server.close();
      }
    }
  );
});
