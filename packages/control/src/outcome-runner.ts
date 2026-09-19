import {
  CONTROL_OPERATION_ID,
  type OutcomeProjection,
  type TrustedVerifierDescriptor,
  type VerificationProjection,
} from '@agentbrowser/protocol';
import { snapshotAuthorizationInput, synchronousResult } from './trusted-callback.js';
import type { TrustedVerifierRegistry } from './verifier-registry.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface TrustedEvidenceSourceDescriptor {
  readonly id: string;
  readonly capability: string;
  /** Requires a business operation ID with the protocol's operation-ID grammar. */
  readonly correlation?: 'required';
  /** Require trusted predicate-specific permission before execution or evidence reads. */
  readonly authorization?: 'required';
}

export interface EvidenceAuthorizationRequest<Context> {
  readonly source: TrustedEvidenceSourceDescriptor;
  readonly verifier: Readonly<{ id: string; version: string; input: unknown }>;
  /** Host-owned context; application composition must supply immutable authority identity. */
  readonly context: Context;
  readonly correlationId?: string;
}

export interface EvidencePermission {
  readonly generation: number;
  /** Policy owners increment this monotonically on every permission change, including regrant. */
  currentGeneration(): number;
}

export interface PreparedEvidenceRead {
  (signal: AbortSignal): EvidenceRead<unknown> | Promise<EvidenceRead<unknown>>;
  readonly assertAuthorized: () => void;
}

export type EvidenceRead<Evidence> =
  | { readonly status: 'pending' }
  | {
      readonly status: 'ready';
      readonly evidence: Evidence;
      readonly evidenceRefIds: readonly string[];
    };

export interface TrustedEvidenceSourceDefinition<Context, Evidence = unknown> {
  readonly descriptor: TrustedEvidenceSourceDescriptor;
  authorize?(request: EvidenceAuthorizationRequest<Context>): EvidencePermission | undefined;
  read(
    context: Context,
    signal: AbortSignal,
    correlationId?: string
  ): EvidenceRead<Evidence> | Promise<EvidenceRead<Evidence>>;
  cleanup?(context: Context, signal: AbortSignal): void | Promise<void>;
}

type StoredEvidenceSource<Context> = {
  readonly descriptor: TrustedEvidenceSourceDescriptor;
  readonly authorize?:
    | ((request: EvidenceAuthorizationRequest<Context>) => EvidencePermission | undefined)
    | undefined;
  readonly read: (
    context: Context,
    signal: AbortSignal,
    correlationId?: string
  ) => EvidenceRead<unknown> | Promise<EvidenceRead<unknown>>;
  readonly cleanup?: ((context: Context, signal: AbortSignal) => void | Promise<void>) | undefined;
};

function sourceDescriptor(input: unknown): TrustedEvidenceSourceDescriptor {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('Invalid evidence source descriptor');
  const own = Object.getOwnPropertyDescriptors(input);
  if (
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(own).some(
      (key) =>
        typeof key !== 'string' ||
        !['id', 'capability', 'correlation', 'authorization'].includes(key)
    ) ||
    Object.values(own).some((property) => 'get' in property || 'set' in property) ||
    !own.id ||
    !own.capability ||
    typeof own.id.value !== 'string' ||
    typeof own.capability.value !== 'string' ||
    !IDENTIFIER.test(own.id.value) ||
    !IDENTIFIER.test(own.capability.value) ||
    (own.correlation !== undefined && own.correlation.value !== 'required') ||
    (own.authorization !== undefined && own.authorization.value !== 'required')
  )
    throw new Error('Invalid evidence source descriptor');
  return Object.freeze({
    id: own.id.value,
    capability: own.capability.value,
    ...(own.correlation ? { correlation: 'required' as const } : {}),
    ...(own.authorization ? { authorization: 'required' as const } : {}),
  });
}

export function defineEvidenceSource<Context, Evidence>(
  definition: TrustedEvidenceSourceDefinition<Context, Evidence>
): TrustedEvidenceSourceDefinition<Context, Evidence> {
  const descriptor = sourceDescriptor(definition.descriptor);
  const { read, cleanup, authorize } = definition;
  if (
    typeof read !== 'function' ||
    (cleanup !== undefined && typeof cleanup !== 'function') ||
    (authorize !== undefined &&
      (typeof authorize !== 'function' || descriptor.authorization !== 'required'))
  )
    throw new Error('Invalid evidence source definition');
  return Object.freeze({
    descriptor,
    read,
    ...(cleanup ? { cleanup } : {}),
    ...(authorize ? { authorize } : {}),
  });
}

function permissionGuard(permission: EvidencePermission | undefined): () => void {
  if (!permission || Object.getPrototypeOf(permission) !== Object.prototype)
    throw new Error('Evidence authorization unavailable');
  const own = Object.getOwnPropertyDescriptors(permission);
  const generation = own.generation?.value;
  const callback = own.currentGeneration?.value;
  if (
    Reflect.ownKeys(own).some((key) => key !== 'generation' && key !== 'currentGeneration') ||
    Object.values(own).some((property) => !Object.hasOwn(property, 'value')) ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    typeof callback !== 'function'
  )
    throw new Error('Evidence authorization unavailable');
  const currentGeneration = callback.bind(permission) as () => number;
  let revoked = false;
  const assertAuthorized = () => {
    try {
      if (revoked || synchronousResult(currentGeneration()) !== generation) throw new Error();
    } catch {
      revoked = true;
      throw new Error('Evidence authorization unavailable');
    }
  };
  assertAuthorized();
  return assertAuthorized;
}

/** Trusted constructor-only sources; no caller-supplied scripts or mutable registration. */
export class TrustedEvidenceSourceRegistry<Context> {
  readonly #sources = new Map<string, StoredEvidenceSource<Context>>();

  constructor(definitions: readonly TrustedEvidenceSourceDefinition<Context, unknown>[] = []) {
    for (const definition of definitions) {
      const captured = defineEvidenceSource(definition);
      const { descriptor, read, cleanup, authorize } = captured;
      const key = this.key(descriptor.id, descriptor.capability);
      if (this.#sources.has(key)) throw new Error('Invalid duplicate evidence source');
      this.#sources.set(
        key,
        Object.freeze({
          descriptor,
          ...(authorize ? { authorize } : {}),
          read: (context: Context, signal: AbortSignal, correlationId?: string) =>
            read(context, signal, correlationId),
          ...(cleanup
            ? { cleanup: (context: Context, signal: AbortSignal) => cleanup(context, signal) }
            : {}),
        })
      );
    }
  }

  supports(id: string, capability: string): boolean {
    return this.#sources.has(this.key(id, capability));
  }

  read(
    id: string,
    capability: string,
    context: Context,
    signal: AbortSignal,
    correlationId?: string,
    verifier?: EvidenceAuthorizationRequest<Context>['verifier']
  ): EvidenceRead<unknown> | Promise<EvidenceRead<unknown>> {
    const read = this.prepareRead(id, capability, context, correlationId, verifier);
    if (!read) throw new Error('Unsupported evidence correlation');
    return read(signal);
  }

  /** Shared correlation preflight, before input parsing or policy callbacks. */
  supportsCorrelation(id: string, capability: string, correlationId?: string): boolean {
    const source = this.require(id, capability);
    if (
      correlationId !== undefined &&
      (typeof correlationId !== 'string' || !CONTROL_OPERATION_ID.test(correlationId))
    )
      throw new Error('Invalid evidence correlation');
    return (source.descriptor.correlation === 'required') === (correlationId !== undefined);
  }

  /** Capture a callable reader and permission fence; undefined means unsupported correlation. */
  prepareRead(
    id: string,
    capability: string,
    context: Context,
    correlationId?: string,
    verifier?: EvidenceAuthorizationRequest<Context>['verifier']
  ): PreparedEvidenceRead | undefined {
    if (!this.supportsCorrelation(id, capability, correlationId)) return undefined;
    const source = this.require(id, capability);
    let assertAuthorized = () => {};
    if (source.descriptor.authorization === 'required') {
      try {
        if (!source.authorize || !verifier) throw new Error();
        const own = Object.getOwnPropertyDescriptors(verifier);
        if (
          Object.getPrototypeOf(verifier) !== Object.prototype ||
          Reflect.ownKeys(own).length !== 3 ||
          Object.values(own).some((property) => !Object.hasOwn(property, 'value')) ||
          typeof own.id?.value !== 'string' ||
          !IDENTIFIER.test(own.id.value) ||
          typeof own.version?.value !== 'string' ||
          !IDENTIFIER.test(own.version.value) ||
          !own.input
        )
          throw new Error();
        const stable = Object.freeze({
          id: own.id.value as string,
          version: own.version.value as string,
          input: snapshotAuthorizationInput(own.input.value),
        });
        const request = Object.freeze({
          source: source.descriptor,
          verifier: stable,
          context,
          ...(correlationId !== undefined ? { correlationId } : {}),
        });
        assertAuthorized = permissionGuard(synchronousResult(source.authorize(request)));
      } catch {
        throw new Error('Evidence authorization unavailable');
      }
    }
    const read = (signal: AbortSignal) => {
      assertAuthorized();
      if (source.descriptor.authorization !== 'required')
        return source.read(context, signal, correlationId);
      return (async () => {
        if (signal.aborted) throw new Error('Evidence read cancelled');
        const result = await source.read(context, signal, correlationId);
        assertAuthorized();
        if (signal.aborted) throw new Error('Evidence read cancelled');
        return result;
      })();
    };
    return Object.freeze(Object.assign(read, { assertAuthorized }));
  }

  cleanup(
    id: string,
    capability: string,
    context: Context
  ): ((signal: AbortSignal) => void | Promise<void>) | undefined {
    const cleanup = this.require(id, capability).cleanup;
    return cleanup ? (signal) => cleanup(context, signal) : undefined;
  }

  private require(id: string, capability: string): StoredEvidenceSource<Context> {
    const source = this.#sources.get(this.key(id, capability));
    if (!source) throw new Error('Unknown evidence source');
    return source;
  }

  private key(id: string, capability: string): string {
    return `${id}\u0000${capability}`;
  }
}

export interface OutcomeRunResult<Result> {
  readonly outcome: OutcomeProjection;
  readonly result?: Result;
}

export interface VerifiedOutcomeRunOptions<Result, Context> {
  readonly verifierRegistry: TrustedVerifierRegistry;
  readonly evidenceSources: TrustedEvidenceSourceRegistry<Context>;
  readonly verifier: { readonly id: string; readonly version: string; readonly input: unknown };
  readonly context: Context;
  readonly evidenceCorrelationId?: string;
  readonly execute: () => Result | Promise<Result>;
  readonly executionFailed?: (result: Result) => boolean;
  readonly assertAuthority: () => void;
  readonly didDispatch?: () => boolean;
  readonly cleanups?: readonly ((signal: AbortSignal) => void | Promise<void>)[];
  readonly testedSeam: OutcomeProjection['testedSeam'];
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

const unknownVerification = (descriptor: TrustedVerifierDescriptor): VerificationProjection => ({
  status: 'unknown',
  verifier: { id: descriptor.id, version: descriptor.version },
  requiredLayer: descriptor.requiredLayer,
  evidenceRefIds: [],
});

function wasDispatched(callback: (() => boolean) | undefined): boolean {
  if (!callback) return true;
  try {
    return callback() === true;
  } catch {
    return true;
  }
}

const TIMEOUT = Symbol('timeout');

async function within<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  outerSignal?: AbortSignal
): Promise<T | typeof TIMEOUT> {
  if (timeoutMs <= 0 || outerSignal?.aborted) return TIMEOUT;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const deadline = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMEOUT);
    }, timeoutMs);
    if (outerSignal) {
      abort = () => {
        controller.abort(outerSignal.reason);
        resolve(TIMEOUT);
      };
      outerSignal.addEventListener('abort', abort, { once: true });
    }
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (outerSignal && abort) outerSignal.removeEventListener('abort', abort);
  }
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (elapsed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(elapsed);
    };
    const timer = setTimeout(() => finish(true), milliseconds);
    const abort = () => finish(false);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function isRead(value: unknown): value is EvidenceRead<unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) return false;
  const keys = Object.keys(descriptors);
  if (Object.values(descriptors).some((property) => 'get' in property || 'set' in property))
    return false;
  const status = descriptors.status?.value;
  if (status === 'pending') return keys.length === 1;
  return (
    status === 'ready' &&
    keys.length === 3 &&
    descriptors.evidence !== undefined &&
    Array.isArray(descriptors.evidenceRefIds?.value)
  );
}

/** Compose an existing executor with bounded trusted verification and all-settled cleanup. */
export async function runVerifiedOutcome<Result, Context>(
  options: VerifiedOutcomeRunOptions<Result, Context>
): Promise<OutcomeRunResult<Result>> {
  // Trusted source callbacks cannot replace the host's fences or execution provenance.
  const {
    verifierRegistry,
    evidenceSources,
    verifier,
    context,
    evidenceCorrelationId: correlationId,
    execute,
    executionFailed,
    assertAuthority,
    didDispatch,
    signal,
    testedSeam,
    now: clock,
    cleanups: registeredCleanups,
  } = options;
  const { id: verifierId, version: verifierVersion, input: verifierInput } = verifier;
  const cleanups = [...(registeredCleanups ?? [])];
  const descriptor = verifierRegistry.describe(verifierId, verifierVersion);
  let availability: OutcomeProjection['availability'] = 'available';
  let execution: OutcomeProjection['execution'] = 'not_started';
  let verification = unknownVerification(descriptor);
  let result: Result | undefined;
  let hasResult = false;
  let cleanup: OutcomeProjection['cleanup'] = 'pending';
  let prepared: ReturnType<TrustedVerifierRegistry['prepare']>;
  let readEvidence: ReturnType<TrustedEvidenceSourceRegistry<Context>['prepareRead']>;
  const now = clock ?? (() => performance.now());
  let accessRevoked = false;
  const assertAccess = () => {
    try {
      if (accessRevoked) throw new Error();
      assertAuthority();
      if (readEvidence) {
        readEvidence.assertAuthorized();
        // Permission callbacks can synchronously revoke the host's admission.
        assertAuthority();
      }
    } catch {
      accessRevoked = true;
      throw new Error('Outcome authority unavailable');
    }
  };

  try {
    const exactSource = evidenceSources.supports(
      descriptor.evidenceSource,
      descriptor.requiredCapability
    );
    if (exactSource) {
      const sourceCleanup = evidenceSources.cleanup(
        descriptor.evidenceSource,
        descriptor.requiredCapability,
        context
      );
      if (sourceCleanup) cleanups.push(sourceCleanup);
    } else {
      availability = 'unsupported';
    }

    if (availability === 'available') {
      if (signal?.aborted) {
        availability = 'blocked';
      } else {
        try {
          assertAccess();
          const correlationSupported = evidenceSources.supportsCorrelation(
            descriptor.evidenceSource,
            descriptor.requiredCapability,
            correlationId
          );
          if (correlationSupported) {
            prepared = verifierRegistry.prepare(
              descriptor.id,
              descriptor.version,
              verifierInput,
              signal
            );
            if (!prepared) availability = 'unsupported';
            else {
              assertAccess();
              if (signal?.aborted) throw new Error();
              readEvidence = evidenceSources.prepareRead(
                descriptor.evidenceSource,
                descriptor.requiredCapability,
                context,
                correlationId,
                {
                  id: descriptor.id,
                  version: descriptor.version,
                  input: prepared.authorizationInput,
                }
              );
              if (!readEvidence) availability = 'unsupported';
            }
          } else {
            availability = 'unsupported';
          }
          assertAccess();
          if (signal?.aborted) availability = 'blocked';
        } catch {
          availability = 'blocked';
        }
      }
    }

    if (availability === 'available') {
      execution = 'running';
      try {
        result = await execute();
        hasResult = true;
        assertAccess();
        const failed = executionFailed?.(result) === true;
        execution = failed ? (wasDispatched(didDispatch) ? 'unknown' : 'failed') : 'completed';
      } catch {
        hasResult = false;
        result = undefined;
        execution = wasDispatched(didDispatch) ? 'unknown' : 'failed';
      }
    }

    if (execution === 'completed' && prepared && readEvidence) {
      const started = now();
      for (let reads = 0; reads < descriptor.budget.maxReads; reads++) {
        const remaining = descriptor.budget.timeoutMs - (now() - started);
        if (remaining <= 0 || signal?.aborted) break;
        let read: EvidenceRead<unknown> | typeof TIMEOUT;
        try {
          assertAccess();
          read = await within(readEvidence, remaining, signal);
          if (read === TIMEOUT) break;
          assertAccess();
        } catch {
          break;
        }
        if (now() - started >= descriptor.budget.timeoutMs) break;
        if (!isRead(read)) break;
        if (read.status === 'pending') {
          if (reads + 1 >= descriptor.budget.maxReads) break;
          const afterRead = descriptor.budget.timeoutMs - (now() - started);
          if (afterRead <= 0) break;
          const elapsed = await pause(
            Math.min(descriptor.budget.pollIntervalMs, afterRead),
            signal
          );
          if (!elapsed) break;
          continue;
        }
        verification = prepared.evaluate(read.evidence, read.evidenceRefIds, signal);
        assertAccess();
        break;
      }
    }
  } catch {
    if (execution === 'running') execution = wasDispatched(didDispatch) ? 'unknown' : 'failed';
  } finally {
    // Promise.resolve().then invokes synchronous callbacks inside the settled promise.
    const settled = await Promise.allSettled(
      cleanups.map((cleanup) =>
        // Cleanup must still be attempted after session/operation cancellation.
        // Its own deadline signal bounds a non-cooperative callback.
        within((signal) => cleanup(signal), descriptor.budget.cleanupTimeoutMs)
      )
    );
    cleanup =
      cleanups.length === 0
        ? descriptor.cleanup === 'required'
          ? 'unknown'
          : 'not_needed'
        : settled.some((entry) => entry.status === 'rejected')
          ? 'failed'
          : settled.some((entry) => entry.status === 'fulfilled' && entry.value === TIMEOUT)
            ? 'unknown'
            : 'complete';
  }
  // Cleanup is asynchronous: authority or cancellation may change after evidence
  // was accepted. Fence the final projection before releasing any result or refs.
  let outputAuthorized = !signal?.aborted;
  try {
    assertAccess();
  } catch {
    outputAuthorized = false;
  }
  if (!outputAuthorized || signal?.aborted) {
    availability = 'blocked';
    verification = unknownVerification(descriptor);
    hasResult = false;
    result = undefined;
    if (execution !== 'not_started') execution = wasDispatched(didDispatch) ? 'unknown' : 'failed';
  }
  const outcome: OutcomeProjection = {
    availability,
    execution,
    verification,
    cleanup,
    testedSeam: testedSeam,
  };
  return {
    outcome,
    ...(hasResult ? { result: result as Result } : {}),
  };
}
