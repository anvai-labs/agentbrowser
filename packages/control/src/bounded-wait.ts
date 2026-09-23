/** Bound caller waiting; callbacks must separately fence late work and output. */
export const TIMEOUT = Symbol('timeout');

export async function within<T>(
  operation: (signal: AbortSignal) => T | PromiseLike<T>,
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
