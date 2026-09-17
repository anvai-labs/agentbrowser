import type {
  OutcomeProjection,
  TrustedVerifierDescriptor,
  VerificationProjection,
} from '@agentbrowser/protocol';
import type { TrustedVerifierRegistry } from './verifier-registry.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface TrustedEvidenceSourceDescriptor {
  readonly id: string;
  readonly capability: string;
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
  read(
    context: Context,
    signal: AbortSignal
  ): EvidenceRead<Evidence> | Promise<EvidenceRead<Evidence>>;
  cleanup?(context: Context, signal: AbortSignal): void | Promise<void>;
}

type StoredEvidenceSource<Context> = {
  readonly descriptor: TrustedEvidenceSourceDescriptor;
  readonly read: (
    context: Context,
    signal: AbortSignal
  ) => EvidenceRead<unknown> | Promise<EvidenceRead<unknown>>;
  readonly cleanup?: ((context: Context, signal: AbortSignal) => void | Promise<void>) | undefined;
};

function sourceDescriptor(input: unknown): TrustedEvidenceSourceDescriptor {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('Invalid evidence source descriptor');
  const own = Object.getOwnPropertyDescriptors(input);
  if (
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(own).some((key) => typeof key !== 'string') ||
    Object.keys(own).length !== 2 ||
    !own.id ||
    !own.capability ||
    'get' in own.id ||
    'set' in own.id ||
    'get' in own.capability ||
    'set' in own.capability ||
    typeof own.id.value !== 'string' ||
    typeof own.capability.value !== 'string' ||
    !IDENTIFIER.test(own.id.value) ||
    !IDENTIFIER.test(own.capability.value)
  )
    throw new Error('Invalid evidence source descriptor');
  return Object.freeze({ id: own.id.value, capability: own.capability.value });
}

export function defineEvidenceSource<Context, Evidence>(definition: {
  readonly descriptor: TrustedEvidenceSourceDescriptor;
  read(
    context: Context,
    signal: AbortSignal
  ): EvidenceRead<Evidence> | Promise<EvidenceRead<Evidence>>;
  cleanup?(context: Context, signal: AbortSignal): void | Promise<void>;
}): TrustedEvidenceSourceDefinition<Context, Evidence> {
  const descriptor = sourceDescriptor(definition.descriptor);
  const { read, cleanup } = definition;
  if (typeof read !== 'function' || (cleanup !== undefined && typeof cleanup !== 'function'))
    throw new Error('Invalid evidence source definition');
  return Object.freeze({ descriptor, read, ...(cleanup ? { cleanup } : {}) });
}

/** Trusted constructor-only sources; no caller-supplied scripts or mutable registration. */
export class TrustedEvidenceSourceRegistry<Context> {
  readonly #sources = new Map<string, StoredEvidenceSource<Context>>();

  constructor(definitions: readonly TrustedEvidenceSourceDefinition<Context, unknown>[] = []) {
    for (const definition of definitions) {
      const descriptor = sourceDescriptor(definition.descriptor);
      const key = this.key(descriptor.id, descriptor.capability);
      if (this.#sources.has(key)) throw new Error('Invalid duplicate evidence source');
      if (
        typeof definition.read !== 'function' ||
        (definition.cleanup !== undefined && typeof definition.cleanup !== 'function')
      )
        throw new Error('Invalid evidence source definition');
      const read = definition.read;
      const cleanup = definition.cleanup;
      this.#sources.set(
        key,
        Object.freeze({
          descriptor,
          read: (context: Context, signal: AbortSignal) => read(context, signal),
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
    signal: AbortSignal
  ): EvidenceRead<unknown> | Promise<EvidenceRead<unknown>> {
    return this.require(id, capability).read(context, signal);
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
  const descriptor = options.verifierRegistry.describe(
    options.verifier.id,
    options.verifier.version
  );
  const cleanups = [...(options.cleanups ?? [])];
  let availability: OutcomeProjection['availability'] = 'available';
  let execution: OutcomeProjection['execution'] = 'not_started';
  let verification = unknownVerification(descriptor);
  let result: Result | undefined;
  let hasResult = false;
  let cleanup: OutcomeProjection['cleanup'] = 'pending';
  const now = options.now ?? (() => performance.now());

  try {
    const exactSource = options.evidenceSources.supports(
      descriptor.evidenceSource,
      descriptor.requiredCapability
    );
    if (exactSource) {
      const sourceCleanup = options.evidenceSources.cleanup(
        descriptor.evidenceSource,
        descriptor.requiredCapability,
        options.context
      );
      if (sourceCleanup) cleanups.push(sourceCleanup);
    } else {
      availability = 'unsupported';
    }

    if (availability === 'available') {
      if (options.signal?.aborted) {
        availability = 'blocked';
      } else {
        try {
          options.assertAuthority();
        } catch {
          availability = 'blocked';
        }
      }
    }

    if (availability === 'available') {
      execution = 'running';
      try {
        result = await options.execute();
        hasResult = true;
        options.assertAuthority();
        const failed = options.executionFailed?.(result) === true;
        execution = failed
          ? wasDispatched(options.didDispatch)
            ? 'unknown'
            : 'failed'
          : 'completed';
      } catch {
        hasResult = false;
        result = undefined;
        execution = wasDispatched(options.didDispatch) ? 'unknown' : 'failed';
      }
    }

    if (execution === 'completed') {
      const started = now();
      for (let reads = 0; reads < descriptor.budget.maxReads; reads++) {
        const remaining = descriptor.budget.timeoutMs - (now() - started);
        if (remaining <= 0 || options.signal?.aborted) break;
        let read: EvidenceRead<unknown> | typeof TIMEOUT;
        try {
          options.assertAuthority();
          read = await within(
            (signal) =>
              options.evidenceSources.read(
                descriptor.evidenceSource,
                descriptor.requiredCapability,
                options.context,
                signal
              ),
            remaining,
            options.signal
          );
          if (read === TIMEOUT) break;
          options.assertAuthority();
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
            options.signal
          );
          if (!elapsed) break;
          continue;
        }
        verification = options.verifierRegistry.evaluate(
          descriptor.id,
          descriptor.version,
          options.verifier.input,
          read.evidence,
          read.evidenceRefIds,
          options.signal
        );
        break;
      }
    }
  } catch {
    if (execution === 'running')
      execution = wasDispatched(options.didDispatch) ? 'unknown' : 'failed';
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
  const outcome: OutcomeProjection = {
    availability,
    execution,
    verification,
    cleanup,
    testedSeam: options.testedSeam,
  };
  return {
    outcome,
    ...(hasResult ? { result: result as Result } : {}),
  };
}
