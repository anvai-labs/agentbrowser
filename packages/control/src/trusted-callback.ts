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
