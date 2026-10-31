import { afterEach, vi } from 'vitest';
/** Shared teardown for ledger-backed amendment fixtures and their injected engines. */
export function scopeTestCleanup(): Array<() => Promise<unknown>> {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of cleanups.splice(0).reverse()) await close();
  });
  return cleanups;
}
