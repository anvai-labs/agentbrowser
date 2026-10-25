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

  it('normalizes a driver timeout rejection to the typed read-timeout contract', async () => {
    // A raw "Timeout …ms exceeded" that wins the race still surfaces as
    // ACTION_TIMEOUT {reason: read_timeout}; anything else rethrows as-is.
    await expect(
      new ObservationReads(5000).read('metadata', async () => {
        throw new Error('page.title: Timeout 30000ms exceeded.');
      })
    ).rejects.toMatchObject({
      code: 'ACTION_TIMEOUT',
      details: { operation: 'observe', stage: 'metadata', reason: 'read_timeout' },
    });
    await expect(
      new ObservationReads(5000).read('metadata', async () => {
        throw new Error('net::ERR_CONNECTION_REFUSED');
      })
    ).rejects.toThrow('net::ERR_CONNECTION_REFUSED');
  });
});
