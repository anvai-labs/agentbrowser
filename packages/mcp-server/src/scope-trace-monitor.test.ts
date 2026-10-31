import type { SessionResponse } from '@agentbrowser/sdk-typescript';
import { expect, it } from 'vitest';
import { ScopeTraceMonitor } from './scope-trace-monitor.js';

it('makes concurrent callers await the same readiness barrier', async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const monitor = new ScopeTraceMonitor(
    {
      traceDenials: async function* (_id, options) {
        await barrier;
        options?.onReady?.();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    },
    () => true
  );
  const session = { sessionId: 's', trace: 'denials' } as SessionResponse;
  const first = monitor.created(session);
  let secondReady = false;
  const second = monitor.created(session).then(() => {
    secondReady = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(secondReady).toBe(false);
  release();
  await Promise.all([first, second]);
  expect(secondReady).toBe(true);
  await monitor.close();
});
