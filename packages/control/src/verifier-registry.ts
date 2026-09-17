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
  /** Synchronously validate input and capture it for later evidence-only evaluation. */
  prepare?(input: unknown): (evidence: unknown) => boolean;
}

export interface PreparedVerifier {
  evaluate(
    evidence: unknown,
    evidenceRefIds: unknown,
    signal?: AbortSignal
  ): VerificationProjection;
}

/** Fail closed on misconfigured async callbacks and consume their rejection safely. */
function synchronousResult<T>(value: T): T {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  ) {
    void Promise.resolve(value).catch(() => undefined);
    throw new Error('Invalid asynchronous verifier callback');
  }
  return value;
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
  const prepare = (input: unknown) => {
    const parsedInput = synchronousResult(parseInput(input));
    return (evidence: unknown) =>
      synchronousResult(predicate(parsedInput, synchronousResult(parseEvidence(evidence))));
  };
  return Object.freeze({
    descriptor,
    prepare,
    evaluate(input: unknown, evidence: unknown) {
      return prepare(input)(evidence);
    },
  });
}

function projectVerification(
  descriptor: TrustedVerifierDescriptor,
  prepareEvaluation: () => (evidence: unknown) => boolean,
  evidence: unknown,
  evidenceRefIds: unknown,
  signal?: AbortSignal
): VerificationProjection {
  const refs = evidenceReferences(evidenceRefIds, descriptor.budget.maxEvidenceRefs);
  const base = {
    verifier: { id: descriptor.id, version: descriptor.version },
    requiredLayer: descriptor.requiredLayer,
    evidenceRefIds: refs,
  } as const;
  if (signal?.aborted) return { status: 'unknown', ...base };
  try {
    const evaluate = prepareEvaluation();
    if (signal?.aborted) return { status: 'unknown', ...base };
    const stableEvidence = snapshotJsonData(evidence, VERIFICATION_SNAPSHOT_LIMITS);
    if (signal?.aborted) return { status: 'unknown', ...base };
    const passed = synchronousResult(evaluate(stableEvidence));
    if (signal?.aborted || typeof passed !== 'boolean') return { status: 'unknown', ...base };
    return {
      status: passed ? 'passed' : 'failed',
      ...base,
      achievedLayer: descriptor.requiredLayer,
    };
  } catch {
    return { status: 'unknown', ...base };
  }
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
        Object.freeze({
          descriptor,
          evaluate: definition.evaluate.bind(definition),
          ...(definition.prepare ? { prepare: definition.prepare.bind(definition) } : {}),
        })
      );
    }
  }

  describe(id: string, version: string): TrustedVerifierDescriptor {
    return this.require(id, version).descriptor;
  }

  /** Undefined means legacy evaluation only; invalid input throws a private-safe error. */
  prepare(
    id: string,
    version: string,
    input: unknown,
    signal?: AbortSignal
  ): PreparedVerifier | undefined {
    const verifier = this.require(id, version);
    if (!verifier.prepare) return undefined;
    try {
      if (signal?.aborted) throw new Error();
      const stableInput = snapshotJsonData(input, VERIFICATION_SNAPSHOT_LIMITS);
      if (signal?.aborted) throw new Error();
      const evaluate = synchronousResult(verifier.prepare(stableInput));
      if (signal?.aborted || typeof evaluate !== 'function') throw new Error();
      return Object.freeze({
        evaluate: (evidence: unknown, refs: unknown, evaluationSignal?: AbortSignal) =>
          projectVerification(
            verifier.descriptor,
            () => evaluate,
            evidence,
            refs,
            evaluationSignal
          ),
      });
    } catch {
      throw new Error('Invalid verifier input preparation');
    }
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
    return projectVerification(
      verifier.descriptor,
      () => {
        const stableInput = snapshotJsonData(input, VERIFICATION_SNAPSHOT_LIMITS);
        return (stableEvidence) => verifier.evaluate(stableInput, stableEvidence);
      },
      evidence,
      evidenceRefIds,
      signal
    );
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
