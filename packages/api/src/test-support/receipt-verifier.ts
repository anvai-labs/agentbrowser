import { defineVerifier, TrustedVerifierRegistry } from '@agentbrowser/control';

/**
 * The receipt.equals fixture verifier the outcome suites share: number-in/number-out
 * equality with a minimal budget — enough to exercise the composition/provider paths
 * without standing up a real verifier.
 */
export const receiptEqualsRegistry = (): TrustedVerifierRegistry =>
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
