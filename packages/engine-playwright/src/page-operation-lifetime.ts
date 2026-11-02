import { EngineError } from '@agentbrowser/engine';
/** Each awaited operation is bounded independently so a late read cannot resume input. */
export class PageOperationLifetime {
  readonly deadline: number;
  private ended = false;
  constructor(
    private readonly signal: AbortSignal,
    private readonly guard: () => void,
    timeoutMs = 15000,
    private readonly operation: 'Coordinate' | 'Fetch' = 'Coordinate'
  ) {
    this.deadline = performance.now() + timeoutMs;
  }
  private failure(stage: string, uncertain: boolean): unknown {
    try {
      this.guard();
    } catch (error) {
      return error;
    }
    if (this.signal.aborted) {
      if (this.signal.reason instanceof EngineError) {
        const reason = this.signal.reason;
        return new EngineError(reason.code, reason.message, false, {
          ...reason.details,
          stage,
          dispatch: uncertain ? 'uncertain' : 'none',
        });
      }
      return new EngineError('PAGE_NOT_FOUND', `${this.operation} page or owner ended`, false, {
        stage,
        dispatch: uncertain ? 'uncertain' : 'none',
      });
    }
    return new EngineError(
      'ACTION_TIMEOUT',
      `${this.operation} operation expired; inspect current state before any retry`,
      false,
      { stage, dispatch: uncertain ? 'uncertain' : 'none' }
    );
  }
  assert(stage = 'coordinate', uncertain = false): void {
    if (this.ended || this.signal.aborted || performance.now() >= this.deadline)
      throw this.failure(stage, uncertain);
    this.guard();
  }
  finish(): void {
    this.ended = true;
  }
  async read<T>(
    stage: string,
    operation: () => Promise<T>,
    disposeLate?: (value: T) => void,
    uncertain = false
  ): Promise<T> {
    this.assert(stage, uncertain);
    let lost = false;
    let completed = false;
    let disposed = false;
    const dispose = (value: T) => {
      if (!disposed) {
        disposed = true;
        disposeLate?.(value);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      lost = true;
      rejectAbort(this.failure(stage, uncertain));
    };
    this.signal.addEventListener('abort', abort, { once: true });
    try {
      const pending = operation().then((value) => {
        if (lost || this.ended || this.signal.aborted) dispose(value);
        return value;
      });
      const timeout = new Promise<never>((_, reject) => {
        // Some authority owners expose a session-close signal while takeover
        // revocation lives in their synchronous guard. Bound that wait too.
        const check = () => {
          try {
            this.assert(stage, uncertain);
          } catch (error) {
            lost = true;
            reject(error);
            return;
          }
          timer = setTimeout(check, Math.min(50, Math.max(1, this.deadline - performance.now())));
        };
        timer = setTimeout(check, Math.min(50, Math.max(1, this.deadline - performance.now())));
      });
      if (this.signal.aborted) abort();
      const value = await Promise.race([pending, aborted, timeout]);
      try {
        this.assert(stage, uncertain);
      } catch (error) {
        dispose(value);
        throw error;
      }
      completed = true;
      return value;
    } finally {
      if (!completed) lost = true;
      if (timer !== undefined) clearTimeout(timer);
      this.signal.removeEventListener('abort', abort);
    }
  }
}
