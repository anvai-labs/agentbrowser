import { expect, it, vi } from 'vitest';
import { CoordinateLifetime } from './coordinate-lifetime.js';

it('bounds a hung read and disposes its late value without resuming the caller', async () => {
  const close = new AbortController();
  let deliver!: (value: Buffer) => void;
  const pending = new Promise<Buffer>((resolve) => {
    deliver = resolve;
  });
  const late = vi.fn((value: Buffer) => value.fill(0));
  const scope = new CoordinateLifetime(close.signal, () => {}, 20);
  await expect(scope.read('fixture', () => pending, late)).rejects.toMatchObject({
    code: 'ACTION_TIMEOUT',
  });
  const bytes = Buffer.from('private');
  deliver(bytes);
  await Promise.resolve();
  await Promise.resolve();
  expect(late).toHaveBeenCalledOnce();
  expect(bytes.every((v) => v === 0)).toBe(true);
  scope.finish();
});
it('aborts a hung read immediately and refuses further work', async () => {
  const close = new AbortController();
  const scope = new CoordinateLifetime(close.signal, () => {}, 15000);
  const pending = scope.read('fixture', () => new Promise(() => {}));
  close.abort();
  await expect(pending).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });
  const next = vi.fn(async () => 1);
  await expect(scope.read('late', next)).rejects.toBeDefined();
  expect(next).not.toHaveBeenCalled();
  scope.finish();
});
it('detects authority revocation during a hung read even when only the session lifetime signal is available', async () => {
  const session = new AbortController();
  let current = true;
  const scope = new CoordinateLifetime(session.signal, () => {
    if (!current) throw new Error('owner changed without session close');
  });
  const settled = vi.fn();
  const outcome = scope
    .read('approval', () => new Promise(() => {}))
    .catch((error) => {
      settled();
      return error;
    });
  try {
    current = false;
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), { timeout: 500 });
    expect(await outcome).toMatchObject({ message: 'owner changed without session close' });
  } finally {
    scope.finish();
    session.abort();
  }
});
it('rechecks live authority after each read and bounds uncertain writes separately', async () => {
  let live = true;
  const close = new AbortController();
  const scope = new CoordinateLifetime(
    close.signal,
    () => {
      if (!live) throw new Error('revoked');
    },
    20
  );
  await expect(
    scope.read('revoked', async () => {
      live = false;
      return 1;
    })
  ).rejects.toThrow('revoked');
  scope.finish();
  const write = new CoordinateLifetime(close.signal, () => {}, 20);
  await expect(
    write.read('input', () => new Promise(() => {}), undefined, true)
  ).rejects.toMatchObject({ code: 'ACTION_TIMEOUT', details: { dispatch: 'uncertain' } });
  write.finish();
});
