import {
  type TrustedVerifierDescriptor,
  VERIFICATION_SNAPSHOT_LIMITS,
  type VerificationProjection,
  parseTrustedVerifierDescriptor,
  snapshotJsonData,
} from '@agentbrowser/protocol';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface TrustedVerifierDefinition {
  readonly descriptor: TrustedVerifierDescriptor;
  evaluate(input: unknown, evidence: unknown): boolean;
}

function freezeDescriptor(input: unknown): TrustedVerifierDescriptor {
  const parsed = parseTrustedVerifierDescriptor(input);
  const budget = { ...parsed.budget };
  const unsupported = [...parsed.unsupported];
  Object.freeze(budget);
  Object.freeze(unsupported);
  const descriptor: TrustedVerifierDescriptor = {
    ...parsed,
    budget,
    unsupported,
  };
  return Object.freeze(descriptor);
}

export function defineVerifier<Input, Evidence>(definition: {
  descriptor: TrustedVerifierDescriptor;
  parseInput(input: unknown): Input;
  parseEvidence(evidence: unknown): Evidence;
  predicate(input: Input, evidence: Evidence): boolean;
}): TrustedVerifierDefinition {
  const descriptor = freezeDescriptor(definition.descriptor);
  const { parseInput, parseEvidence, predicate } = definition;
  if (
    typeof parseInput !== 'function' ||
    typeof parseEvidence !== 'function' ||
    typeof predicate !== 'function'
  )
    throw new Error('Invalid verifier definition');
  return Object.freeze({
    descriptor,
    evaluate(input: unknown, evidence: unknown) {
      return predicate(parseInput(input), parseEvidence(evidence));
    },
  });
}

function evidenceReferences(input: unknown, maximum: number): string[] {
  let snapshot: unknown;
  try {
    snapshot = snapshotJsonData(input, VERIFICATION_SNAPSHOT_LIMITS);
  } catch {
    throw new Error('Invalid evidence references');
  }
  if (
    !Array.isArray(snapshot) ||
    snapshot.length === 0 ||
    snapshot.length > maximum ||
    snapshot.some((value) => typeof value !== 'string' || !IDENTIFIER.test(value)) ||
    new Set(snapshot).size !== snapshot.length
  )
    throw new Error('Invalid evidence references');
  return snapshot as string[];
}

/** Trusted configuration only: this registry performs no reads, polling, writes or cleanup. */
export class TrustedVerifierRegistry {
  readonly #verifiers = new Map<string, TrustedVerifierDefinition>();

  constructor(definitions: readonly TrustedVerifierDefinition[] = []) {
    for (const definition of definitions) {
      const descriptor = freezeDescriptor(definition.descriptor);
      const key = this.key(descriptor.id, descriptor.version);
      if (this.#verifiers.has(key)) throw new Error('Invalid duplicate verifier');
      this.#verifiers.set(
        key,
        Object.freeze({ descriptor, evaluate: definition.evaluate.bind(definition) })
      );
    }
  }

  describe(id: string, version: string): TrustedVerifierDescriptor {
    return this.require(id, version).descriptor;
  }

  evaluate(
    id: string,
    version: string,
    input: unknown,
    evidence: unknown,
    evidenceRefIds: unknown,
    signal?: AbortSignal
  ): VerificationProjection {
    const verifier = this.require(id, version);
    const refs = evidenceReferences(evidenceRefIds, verifier.descriptor.budget.maxEvidenceRefs);
    const base = {
      verifier: { id: verifier.descriptor.id, version: verifier.descriptor.version },
      requiredLayer: verifier.descriptor.requiredLayer,
      evidenceRefIds: refs,
    } as const;
    if (signal?.aborted) return { status: 'unknown', ...base };
    try {
      const stableInput = snapshotJsonData(input, VERIFICATION_SNAPSHOT_LIMITS);
      if (signal?.aborted) return { status: 'unknown', ...base };
      const stableEvidence = snapshotJsonData(evidence, VERIFICATION_SNAPSHOT_LIMITS);
      if (signal?.aborted) return { status: 'unknown', ...base };
      const passed = verifier.evaluate(stableInput, stableEvidence);
      if (signal?.aborted) return { status: 'unknown', ...base };
      if (typeof passed !== 'boolean') return { status: 'unknown', ...base };
      return {
        status: passed ? 'passed' : 'failed',
        ...base,
        achievedLayer: verifier.descriptor.requiredLayer,
      };
    } catch {
      return { status: 'unknown', ...base };
    }
  }

  private require(id: string, version: string): TrustedVerifierDefinition {
    const verifier = this.#verifiers.get(this.key(id, version));
    if (!verifier) throw new Error('Unknown verifier');
    return verifier;
  }

  private key(id: string, version: string): string {
    return `${id}\u0000${version}`;
  }
}
