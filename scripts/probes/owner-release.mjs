import { setTimeout as delay } from 'node:timers/promises';

export const workerAttachOptions = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'worker', exclude: false }, { exclude: true }] };

export async function initializeWorker({ send, abort, holdMs, signal }) {
  try {
    signal?.throwIfAborted();
    await send('Target.setAutoAttach', workerAttachOptions);
    if (holdMs) await delay(holdMs, undefined, { signal });
    signal?.throwIfAborted();
    await send('Runtime.runIfWaitingForDebugger');
  } catch (error) {
    await abort();
    throw error;
  }
}
