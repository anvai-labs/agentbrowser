import { describe, expect, it, vi } from 'vitest';
import { ObservationReads } from './observation-read.js';

describe('bounded observation reads', () => {
  it('times out a stalled read, disposes late handles, and never resumes its caller', async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: string) => void;
      const pending = new Promise<string>((done) => {
        resolve = done;
      });
      const dispose = vi.fn();
      const resume = vi.fn();
      const task = new ObservationReads(100)
        .read('binding', () => pending, 100, dispose)
        .then(resume);
      const result = expect(task).rejects.toMatchObject({
        code: 'ACTION_TIMEOUT',
        details: {
          operation: 'observe',
          stage: 'binding',
          reason: 'read_timeout',
          correlationId: expect.any(String),
        },
      });
      await vi.advanceTimersByTimeAsync(101);
      await result;
      resolve('handle');
      await Promise.resolve();
      expect(resume).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledWith('handle');
      await expect(new ObservationReads().read('metadata', async () => 'ready')).resolves.toBe(
        'ready'
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
