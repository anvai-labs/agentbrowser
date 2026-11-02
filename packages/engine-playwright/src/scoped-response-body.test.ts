import { expect, it, vi } from 'vitest';
import { scopedResponseBody } from './scoped-response-body.js';

it('decodes binary chunks exactly and closes the stream', async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce({ stream: 'body' })
    .mockResolvedValueOnce({ data: 'AP9B', base64Encoded: true, eof: true })
    .mockResolvedValue({});
  expect(await scopedResponseBody({ send } as any, 'request')).toEqual(Buffer.from([0, 255, 65]));
  expect(send).toHaveBeenLastCalledWith('IO.close', { handle: 'body' });
});
it('fails closed on overflow before returning any body and closes the stream', async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce({ stream: 'body' })
    .mockResolvedValueOnce({ data: 'too large', eof: true })
    .mockResolvedValue({});
  await expect(scopedResponseBody({ send } as any, 'request', { maxBytes: 4 })).rejects.toThrow(
    'SCOPED_RESPONSE_TOO_LARGE'
  );
  expect(send).toHaveBeenLastCalledWith('IO.close', { handle: 'body' });
});
it('settles a stalled read by its deadline even if stream closure never resolves', async () => {
  vi.useFakeTimers();
  try {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ stream: 'body' })
      .mockImplementation(() => new Promise(() => {}));
    const task = scopedResponseBody({ send } as any, 'request', { timeoutMs: 20 });
    const assertion = expect(task).rejects.toThrow('SCOPED_RESPONSE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(send).toHaveBeenLastCalledWith('IO.close', { handle: 'body' });
  } finally {
    vi.useRealTimers();
  }
});
it('closes a stream that arrives after acquisition timed out', async () => {
  vi.useFakeTimers();
  try {
    let resolve!: (value: { stream: string }) => void;
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      )
      .mockResolvedValue({});
    const task = scopedResponseBody({ send } as any, 'request', { timeoutMs: 20 });
    const assertion = expect(task).rejects.toThrow('SCOPED_RESPONSE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    resolve({ stream: 'late' });
    await Promise.resolve();
    expect(send).toHaveBeenLastCalledWith('IO.close', { handle: 'late' });
  } finally {
    vi.useRealTimers();
  }
});

it('does not acquire a stream once the deadline has expired', async () => {
  const send = vi.fn().mockResolvedValue({ stream: 'must-not-start' });
  await expect(scopedResponseBody({ send } as any, 'request', { timeoutMs: 0 })).rejects.toThrow(
    'SCOPED_RESPONSE_TIMEOUT'
  );
  expect(send).not.toHaveBeenCalled();
});

it('does not acquire a stream for an already-cancelled owner', async () => {
  const controller = new AbortController();
  controller.abort();
  const send = vi.fn();
  await expect(
    scopedResponseBody({ send } as any, 'request', { signal: controller.signal })
  ).rejects.toThrow('SCOPED_RESPONSE_ABORTED');
  expect(send).not.toHaveBeenCalled();
});

it('closes a late stream after cancellation without reading it', async () => {
  const controller = new AbortController();
  let resolve!: (value: { stream: string }) => void;
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    )
    .mockResolvedValue({});
  const task = scopedResponseBody({ send } as any, 'request', { signal: controller.signal });
  const assertion = expect(task).rejects.toThrow('SCOPED_RESPONSE_ABORTED');
  controller.abort();
  await assertion;
  resolve({ stream: 'late' });
  await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith('IO.close', { handle: 'late' }));
  expect(send).not.toHaveBeenCalledWith('IO.read', expect.anything());
});

it('bounds a hanging incremental policy and never reads another chunk', async () => {
  vi.useFakeTimers();
  try {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ stream: 'body' })
      .mockResolvedValueOnce({ data: 'first', eof: false })
      .mockResolvedValue({});
    const checkBytes = vi.fn(async (bytes) => {
      if (bytes > 0) await new Promise(() => {});
    });
    const task = scopedResponseBody({ send } as any, 'request', { timeoutMs: 20, checkBytes });
    const assertion = expect(task).rejects.toThrow('SCOPED_RESPONSE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(send.mock.calls.filter(([method]) => method === 'IO.read')).toHaveLength(1);
    expect(send).toHaveBeenLastCalledWith('IO.close', { handle: 'body' });
  } finally {
    vi.useRealTimers();
  }
});

it('stops a pending CDP read when authority is revoked without an abort signal', async () => {
  vi.useFakeTimers();
  try {
    let live = true;
    const send = vi
      .fn()
      .mockResolvedValueOnce({ stream: 'body' })
      .mockImplementation(() => new Promise(() => {}));
    const task = scopedResponseBody({ send } as any, 'request', {
      assertCurrent: () => {
        if (!live) throw new Error('revoked');
      },
    });
    const assertion = expect(task).rejects.toThrow('revoked');
    await vi.advanceTimersByTimeAsync(1);
    live = false;
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(send).toHaveBeenLastCalledWith('IO.close', { handle: 'body' });
  } finally {
    vi.useRealTimers();
  }
});

it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, 8 * 1024 * 1024 + 1])(
  'refuses invalid byte bound %s before CDP',
  async (maxBytes) => {
    const send = vi.fn();
    await expect(scopedResponseBody({ send } as any, 'request', { maxBytes })).rejects.toThrow(
      'SCOPED_RESPONSE_INVALID_BOUND'
    );
    expect(send).not.toHaveBeenCalled();
  }
);
