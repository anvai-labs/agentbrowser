import { EngineError } from '@agentbrowser/engine';

/** One bounded initialization lifetime; late engine completions never resume the transfer. */
export function evidenceLifetime(source: AbortSignal, target: AbortSignal, timeoutMs = 30000) {
  const deadline = new AbortController();
  const signal = AbortSignal.any([source, target, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  timer.unref?.();
  const canceled = () =>
    new EngineError('ACTION_TIMEOUT', 'Evidence initialization canceled or timed out', false, {
      rule: 'floor.evidence.lifetime',
    });
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      if (signal.aborted) return Promise.reject(canceled());
      return new Promise<T>((resolve, reject) => {
        const abort = () => {
          cleanup();
          reject(canceled());
        };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        void Promise.resolve()
          .then(() => {
            if (signal.aborted) throw canceled();
            return work();
          })
          .then(
            (value) => {
              cleanup();
              if (signal.aborted) reject(canceled());
              else resolve(value);
            },
            (error: unknown) => {
              cleanup();
              reject(error);
            }
          );
      });
    },
    stop() {
      clearTimeout(timer);
      deadline.abort();
    },
  };
}
