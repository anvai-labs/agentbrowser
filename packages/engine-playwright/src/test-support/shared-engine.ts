import { afterAll } from 'vitest';
import { PlaywrightChromiumEngine } from '../index.js';

/**
 * One Chromium launch amortized across a whole suite file: call at module scope, get
 * the shared engine, and the afterAll close is registered here. Each test still opens
 * (and in its finally closes) its own session — full isolation, one launch. The
 * CI-execution lever for launch-dense suites; the engine relaunches if the shared
 * browser dies mid-file (acquireSharedBrowser clears the slot on disconnect).
 *
 * NOTE: src/test-support is excluded from the package tsconfig (the repo convention),
 * so this file is NOT type-checked — keep its types trivial.
 */
export function sharedEngine(): PlaywrightChromiumEngine {
  const engine = new PlaywrightChromiumEngine();
  afterAll(async () => {
    await engine.close();
  });
  return engine;
}
