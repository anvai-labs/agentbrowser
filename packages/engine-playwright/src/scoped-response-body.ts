import type { CDPSession } from 'playwright';

export interface ScopedResponseBodyOptions {
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Captured authority, checked even while a transport/policy promise stalls. */
  assertCurrent?: () => void;
  /** Cumulative decoded bytes, including zero before any body is acquired. */
  checkBytes?: (bytes: number) => Promise<void>;
}

/** Header-only response overrides can be ignored by Chromium (#34826 upstream).
 * Read the decoded body explicitly, with a hard byte/deadline bound, before
 * committing the independent scoped worker policy. Native upload bytes stay native.
 */
export async function scopedResponseBody(
  cdp: Pick<CDPSession, 'send'>,
  requestId: string,
  {
    maxBytes = 8 * 1024 * 1024,
    timeoutMs = 15000,
    signal,
    assertCurrent,
    checkBytes,
  }: ScopedResponseBodyOptions = {}
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 8 * 1024 * 1024)
    throw new Error('SCOPED_RESPONSE_INVALID_BOUND');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 15000)
    throw new Error('SCOPED_RESPONSE_INVALID_BOUND');
  const deadline = performance.now() + timeoutMs;
  let handle: string | undefined;
  const close = (stream: string) => cdp.send('IO.close', { handle: stream }).catch(() => {});
  const assert = () => {
    assertCurrent?.();
    if (signal?.aborted) throw new Error('SCOPED_RESPONSE_ABORTED');
    if (performance.now() >= deadline) throw new Error('SCOPED_RESPONSE_TIMEOUT');
  };
  const read = async <T>(start: () => Promise<T>, late?: (value: T) => unknown): Promise<T> => {
    assert();
    let lost = false;
    let completed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const value = await Promise.race([
        start().then((value) => {
          if (lost) {
            late?.(value);
          }
          return value;
        }),
        new Promise<never>((_, reject) => {
          const check = () => {
            try {
              assert();
            } catch (error) {
              lost = true;
              reject(error);
              return;
            }
            timer = setTimeout(check, Math.min(50, Math.max(1, deadline - performance.now())));
          };
          abort = check;
          signal?.addEventListener('abort', abort, { once: true });
          check();
        }),
      ]);
      try {
        assert();
      } catch (error) {
        late?.(value);
        throw error;
      }
      completed = true;
      return value;
    } finally {
      if (!completed) lost = true;
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  };
  const chunks: Buffer[] = [];
  try {
    if (checkBytes) await read(() => checkBytes(0));
    const stream = await read(
      () => cdp.send('Fetch.takeResponseBodyAsStream', { requestId }),
      (value) => close(value.stream)
    );
    handle = stream.stream;
    let total = 0;
    while (true) {
      const chunk = await read(() =>
        cdp.send('IO.read', {
          handle: handle as string,
          size: Math.min(65536, maxBytes - total + 1),
        })
      );
      const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
      try {
        total += bytes.length;
        if (total > maxBytes) throw new Error('SCOPED_RESPONSE_TOO_LARGE');
        if (checkBytes) await read(() => checkBytes(total));
        // Copy before clearing the decoded transport chunk in finally.
        if (bytes.length) chunks.push(Buffer.from(bytes));
      } finally {
        bytes.fill(0);
      }
      if (chunk.eof) return Buffer.concat(chunks, total);
    }
  } finally {
    for (const bytes of chunks) bytes.fill(0);
    if (handle) void close(handle);
  }
}
