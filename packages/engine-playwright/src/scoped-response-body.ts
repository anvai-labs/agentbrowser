import type { CDPSession } from 'playwright';

/** Header-only response overrides can be ignored by Chromium (#34826 upstream).
 * Read the decoded body explicitly, with a hard byte/deadline bound, before
 * committing the independent scoped worker policy. Native upload bytes stay native.
 */
export async function scopedResponseBody(
  cdp: Pick<CDPSession, 'send'>,
  requestId: string,
  { maxBytes = 8 * 1024 * 1024, timeoutMs = 15000 }: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<Buffer> {
  const deadline = performance.now() + timeoutMs;
  let handle: string | undefined;
  const close = (stream: string) => cdp.send('IO.close', { handle: stream }).catch(() => {});
  const read = async <T>(start: () => Promise<T>, late?: (value: T) => unknown): Promise<T> => {
    if (performance.now() >= deadline) throw new Error('SCOPED_RESPONSE_TIMEOUT');
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        start().then((value) => {
          if (expired || performance.now() >= deadline) {
            late?.(value);
            throw new Error('SCOPED_RESPONSE_TIMEOUT');
          }
          return value;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              expired = true;
              reject(new Error('SCOPED_RESPONSE_TIMEOUT'));
            },
            Math.max(0, deadline - performance.now())
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const stream = await read(
      () => cdp.send('Fetch.takeResponseBodyAsStream', { requestId }),
      (value) => close(value.stream)
    );
    handle = stream.stream;
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = await read(() =>
        cdp.send('IO.read', {
          handle: handle as string,
          size: Math.min(65536, maxBytes - total + 1),
        })
      );
      const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
      total += bytes.length;
      if (total > maxBytes) throw new Error('SCOPED_RESPONSE_TOO_LARGE');
      if (bytes.length) chunks.push(bytes);
      if (chunk.eof) return Buffer.concat(chunks, total);
    }
  } finally {
    if (handle) void close(handle);
  }
}
