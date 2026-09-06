import { EngineError } from '@agentbrowser/engine';

/** WebDriver's selected window belongs to the session, not an individual page. */
export class OperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  run<T>(operation: () => Promise<T>, assertOpen: () => void): Promise<T> {
    return this.enqueue(operation, assertOpen, false);
  }

  /** Cleanup is never rejected for saturation; callers make it idempotent. */
  finish(operation: () => Promise<void>): Promise<void> {
    return this.enqueue(operation, () => {}, true);
  }

  private async enqueue<T>(
    operation: () => Promise<T>,
    assertOpen: () => void,
    cleanup: boolean
  ): Promise<T> {
    assertOpen();
    if (!cleanup && this.pending >= 128)
      throw new EngineError('QUOTA_EXCEEDED', 'Safari operation queue is full', false, {
        reason: 'OPERATION_QUEUE_FULL',
      });
    this.pending += 1;
    const result = this.tail
      .then(async () => {
        assertOpen();
        const value = await operation();
        assertOpen();
        return value;
      })
      .finally(() => {
        this.pending -= 1;
      });
    // A failed command must not poison every subsequent operation.
    this.tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }
}
