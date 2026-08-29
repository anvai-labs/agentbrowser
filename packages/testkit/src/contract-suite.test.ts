/**
 * TDD Tests for the reusable engine contract suite
 *
 * The suite itself is proven by running it against the reference
 * implementation (FakeEngine). Third-party engines verify by running the
 * identical function.
 */

import { describe, expect, it } from 'vitest';
import { runEngineContractSuite } from './contract-suite';
import { FakeEngine } from './fake-engine';

describe('runEngineContractSuite', () => {
  it('passes against the reference FakeEngine', async () => {
    await expect(runEngineContractSuite(new FakeEngine())).resolves.toBeUndefined();
  });

  it('fails when a contract invariant is violated', async () => {
    // Reference engine with a broken resolve: must be caught by the suite.
    class BrokenEngine extends FakeEngine {
      async createSession() {
        const session = await super.createSession({});
        return new Proxy(session, {
          get(target, prop) {
            if (prop === 'newPage') {
              return async () => {
                throw new Error('broken');
              };
            }
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
            void 0;
          },
        }) as never;
      }
    }

    await expect(runEngineContractSuite(new BrokenEngine())).rejects.toThrow();
  });
});
