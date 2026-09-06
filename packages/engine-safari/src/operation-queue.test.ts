import { expect, it } from 'vitest';
import { OperationQueue } from './operation-queue.js';

it('bounds admission, permits cleanup at capacity, and recovers after failure', async () => {
  const queue = new OperationQueue();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.run(
    () => held,
    () => {}
  );
  const pending = Array.from({ length: 127 }, () =>
    queue.run(
      async () => {},
      () => {}
    )
  );
  await expect(
    queue.run(
      async () => {},
      () => {}
    )
  ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  let cleaned = false;
  const cleanup = queue.finish(async () => {
    cleaned = true;
  });
  release();
  await Promise.all([first, ...pending, cleanup]);
  expect(cleaned).toBe(true);
  await expect(
    queue.run(
      async () => {
        throw new Error('command failed');
      },
      () => {}
    )
  ).rejects.toThrow('command failed');
  await expect(
    queue.run(
      async () => 'recovered',
      () => {}
    )
  ).resolves.toBe('recovered');
});
