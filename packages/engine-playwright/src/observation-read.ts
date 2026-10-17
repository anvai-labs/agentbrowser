import { randomUUID } from 'node:crypto';
import { EngineError } from '@agentbrowser/engine';

/** Bound read-only protocol calls that Playwright does not give a timeout.
 * Race individual reads, never a whole observe task: a late read cannot resume
 * the caller and publish refs into the next observation. This is not write cancellation.
 */
export class ObservationReads {
  readonly correlationId = randomUUID();
  private readonly started = performance.now();
  constructor(private readonly timeoutMs = 15000) {}

  async read<T>(
    stage: string,
    read: () => Promise<T>,
    sliceMs = this.timeoutMs,
    disposeLate?: (value: T) => void
  ): Promise<T> {
    const remaining = Math.min(sliceMs, this.timeoutMs - (performance.now() - this.started));
    const failure = () =>
      new EngineError(
        'ACTION_TIMEOUT',
        'Observation read timed out; inspect the page and observe again before another write.',
        true,
        {
          operation: 'observe',
          stage,
          correlationId: this.correlationId,
          elapsedMs: Math.round(performance.now() - this.started),
          reason: 'read_timeout',
        }
      );
    if (remaining <= 0) throw failure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    try {
      const pending = read().then((value) => {
        if (expired) disposeLate?.(value);
        return value;
      });
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(failure());
          }, remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
