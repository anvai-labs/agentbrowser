import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { UsageError } from '@agentbrowser/sdk-typescript';

export const MAX_JSON_INPUT_BYTES = 1024 * 1024;
export const JSON_INPUT_TIMEOUT_MS = 30_000;
export type JsonInputStream = Readable & { isTTY?: boolean };

/** One reader per invocation: preserve @file/inline/- syntax and single stdin ownership. */
export function createJsonArgumentReader(
  options: { stdin?: JsonInputStream; maxBytes?: number; timeoutMs?: number } = {}
) {
  const maxBytes = options.maxBytes ?? MAX_JSON_INPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? JSON_INPUT_TIMEOUT_MS;
  let stdinUsed = false;
  const tooLarge = () => new UsageError(`JSON input exceeds ${maxBytes} bytes.`);

  const readStream = (stream: Readable, label: string): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        stream.pause();
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
        stream.removeListener('error', onError);
        stream.removeListener('close', onError);
        // No error argument: don't emit a new unhandled error during cleanup.
        stream.destroy();
        if (error) reject(error);
        else resolve(Buffer.concat(chunks, size));
      };
      const onData = (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes) finish(tooLarge());
        else chunks.push(bytes);
      };
      const onEnd = () => finish();
      const onError = () => finish(new UsageError(`Could not read ${label}.`));
      const timer = setTimeout(
        () => finish(new UsageError(`Reading ${label} timed out after ${timeoutMs} ms.`)),
        timeoutMs
      );
      stream.on('data', onData);
      stream.once('end', onEnd);
      stream.once('error', onError);
      stream.once('close', onError);
    });

  return async (raw: string, label: string): Promise<unknown> => {
    let bytes: Buffer;
    if (raw === '-') {
      if (stdinUsed) throw new UsageError('Stdin can be used only once per command.');
      stdinUsed = true;
      const stdin = options.stdin ?? process.stdin;
      if (stdin.isTTY)
        throw new UsageError('Provide JSON through a pipe or @file; stdin is interactive.');
      bytes = await readStream(stdin, label);
    } else if (raw.startsWith('@')) {
      try {
        // O_NONBLOCK prevents waiting on a FIFO before it can be rejected by fstat.
        const file = await open(raw.slice(1), constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile()) throw new UsageError('JSON input must be a regular file.');
          if (stat.size > maxBytes) throw tooLarge();
          bytes = await readStream(file.createReadStream({ autoClose: false }), label);
        } finally {
          await file.close();
        }
      } catch (error) {
        if (error instanceof UsageError) throw error;
        throw new UsageError(`Could not read ${label}.`);
      }
    } else {
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw tooLarge();
      bytes = Buffer.from(raw, 'utf8');
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new UsageError(`${label} must be valid UTF-8.`);
    }
    try {
      return JSON.parse(text);
    } catch {
      // JSON.parse messages can contain private values. Never expose them.
      throw new UsageError(`${label} must be valid JSON.`);
    }
  };
}
