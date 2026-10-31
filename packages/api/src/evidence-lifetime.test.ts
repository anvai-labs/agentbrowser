import { expect, it, vi } from 'vitest';
import { evidenceLifetime } from './evidence-lifetime.js';

it('bounds a never-resolving engine operation and discards late completion', async () => {
  vi.useFakeTimers();
  const lifetime = evidenceLifetime(new AbortController().signal, new AbortController().signal);
  try {
    let complete!: (value: string) => void;
    const operation = lifetime.run(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        })
    );
    const rejection = expect(operation).rejects.toMatchObject({ code: 'ACTION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(30000);
    await rejection;
    complete('late-secret');
    await expect(lifetime.run(async () => 'new work')).rejects.toMatchObject({
      code: 'ACTION_TIMEOUT',
    });
  } finally {
    lifetime.stop();
    vi.useRealTimers();
  }
});
