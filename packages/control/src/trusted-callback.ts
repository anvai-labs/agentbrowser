import { VERIFICATION_SNAPSHOT_LIMITS, snapshotJsonData } from '@agentbrowser/protocol';

/** Fail closed on misconfigured async callbacks and consume their rejection safely. */
export function synchronousResult<T>(value: T): T {
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

function deeplyFreezeSnapshot<T>(value: T): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) deeplyFreezeSnapshot(descriptor.value);
  }
  return Object.freeze(value);
}

/** Capture bounded raw-domain policy input without retaining caller-owned references. */
export function snapshotAuthorizationInput(input: unknown): unknown {
  return deeplyFreezeSnapshot(snapshotJsonData(input, VERIFICATION_SNAPSHOT_LIMITS));
}

export function evidencePermissionGuard(permission: unknown): () => void {
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
