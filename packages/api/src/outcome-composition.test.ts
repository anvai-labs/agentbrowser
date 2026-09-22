/**
 * Coverage for the blessed application-receipt outcome composition
 * (outcome-composition.ts): the ServerOptions shape it returns, the
 * verifier-descriptor-derived evidence source identity, and the wired
 * service behavior end to end (blocked run when the deployment's
 * authorize callback refuses).
 */

import {
  type ApplicationReceiptAuthorizationRequest,
  TrustedEvidenceSourceRegistry,
  TrustedVerifierRegistry,
  defineVerifier,
} from '@agentbrowser/control';
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it, vi } from 'vitest';
import { applicationReceiptOutcomeOptions } from './outcome-composition.js';
import { AgentBrowserService } from './service.js';

const verifierRegistry = (): TrustedVerifierRegistry =>
  new TrustedVerifierRegistry([
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
  ]);

const authorize = vi.fn((_request: ApplicationReceiptAuthorizationRequest) => undefined);
const adapters = [
  {
    id: 'fixture-app',
    authorize: () => true,
    operations: {},
    receipt: async () => undefined,
  },
];

describe('applicationReceiptOutcomeOptions', () => {
  it('returns copied adapters, the given verifier registry, and a synchronous provider', () => {
    const registry = verifierRegistry();
    const describeSpy = vi.spyOn(registry, 'describe');
    const composed = applicationReceiptOutcomeOptions({
      adapters,
      verifierRegistry: registry,
      verifier: { id: 'receipt.equals', version: '1' },
      authorize,
      evidenceRefs: () => ['fixture-receipt'],
    });

    // The descriptor names the receipt source, so the identifiers cannot
    // disagree between the verifier and the evidence source.
    expect(describeSpy).toHaveBeenCalledWith('receipt.equals', '1');
    expect(composed.verifierRegistry).toBe(registry);
    expect(composed.applicationAdapters).toEqual(adapters);
    expect(composed.applicationAdapters).not.toBe(adapters);
    expect(typeof composed.evidenceSourceRegistryProvider).toBe('function');
  });

  it('wires the provider into a service as a real evidence source registry', () => {
    for (const evidenceRefs of [
      () => ['fixture-receipt'],
      undefined as unknown as ((receipt: unknown) => readonly string[]) | undefined,
    ]) {
      const composed = applicationReceiptOutcomeOptions({
        adapters,
        verifierRegistry: verifierRegistry(),
        verifier: { id: 'receipt.equals', version: '1' },
        authorize,
        ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
      });
      const provider = vi.fn(composed.evidenceSourceRegistryProvider);
      const engine = new FakeEngine();
      const service = new AgentBrowserService({
        engine,
        applicationAdapters: [...composed.applicationAdapters],
        verifierRegistry: composed.verifierRegistry,
        evidenceSourceRegistryProvider: provider as never,
      });
      // The service invoked the provider exactly once, with its frozen
      // narrow builder, and accepted the returned registry (it rejects
      // async or non-registry values loudly).
      expect(provider).toHaveBeenCalledOnce();
      const builder = provider.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.isFrozen(builder)).toBe(true);
      expect(typeof builder.applicationReceipt).toBe('function');
      expect(service.executeOutcome).toBeDefined();
    }
  });

  it('blocks an outcome run when the deployment authorize callback refuses', async () => {
    const composed = applicationReceiptOutcomeOptions({
      adapters,
      verifierRegistry: verifierRegistry(),
      verifier: { id: 'receipt.equals', version: '1' },
      authorize,
    });
    const engine = new FakeEngine();
    const service = new AgentBrowserService({
      engine,
      applicationAdapters: [...composed.applicationAdapters],
      verifierRegistry: composed.verifierRegistry,
      evidenceSourceRegistryProvider: composed.evidenceSourceRegistryProvider,
    });
    try {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;
      const report = await service.executeOutcome(sessionId, pageId, {
        actions: [{ action: 'press', key: 'Tab' }],
        verification: {
          verifier: { id: 'receipt.equals', version: '1' },
          input: 7,
          evidenceCorrelationId: 'shared-business',
        },
      });
      // No grant was ever recorded, so the deployment deny list keeps the
      // run from dispatching: blocked before execution, verification unknown.
      expect(report.outcome).toMatchObject({
        availability: 'blocked',
        execution: 'not_started',
        verification: { status: 'unknown', evidenceRefIds: [] },
      });
      expect(report.plan.ok).toBe(false);
    } finally {
      await service.shutdown();
    }
  });

  it('rejects an outcome run naming a verifier outside the composed registry', async () => {
    const composed = applicationReceiptOutcomeOptions({
      adapters,
      verifierRegistry: verifierRegistry(),
      verifier: { id: 'receipt.equals', version: '1' },
      authorize,
    });
    const service = new AgentBrowserService({
      engine: new FakeEngine(),
      applicationAdapters: [...composed.applicationAdapters],
      verifierRegistry: composed.verifierRegistry,
      evidenceSourceRegistryProvider: composed.evidenceSourceRegistryProvider,
    });
    try {
      const sessionId = (await service.createSession({ tenantId: 't1' })).sessionId;
      const pageId = (await service.createPage(sessionId)).pageId;
      await expect(
        service.executeOutcome(sessionId, pageId, {
          actions: [{ action: 'press', key: 'Tab' }],
          verification: {
            verifier: { id: 'unknown.verifier', version: '1' },
            input: 7,
          },
        })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: 'Unknown outcome verifier.' });
    } finally {
      await service.shutdown();
    }
  });
});
