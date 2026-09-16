import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createJsonArgumentReader } from './json-input.js';

describe('bounded JSON arguments', () => {
  it('accepts the exact byte ceiling and rejects multibyte overflow', async () => {
    const read = createJsonArgumentReader({ maxBytes: 4 });
    expect(await read('"é"', 'request')).toBe('é');
    await expect(read('"€"', 'request')).rejects.toThrow('4 bytes');
  });

  it('decodes split UTF-8 chunks only after complete input', async () => {
    const bytes = Buffer.from('{"value":"é"}');
    const stdin = Readable.from([bytes.subarray(0, 11), bytes.subarray(11)]);
    expect(await createJsonArgumentReader({ stdin })('-', 'request')).toEqual({ value: 'é' });
  });

  it('rejects invalid UTF-8 without replacing payload bytes', async () => {
    const stdin = Readable.from([Buffer.from([34, 0xff, 34])]);
    await expect(createJsonArgumentReader({ stdin })('-', 'request')).rejects.toThrow('UTF-8');
  });

  it('stops an oversized stream before EOF and cleans up listeners', async () => {
    const stdin = new PassThrough();
    const result = createJsonArgumentReader({ stdin, maxBytes: 4 })('-', 'request');
    const rejected = expect(result).rejects.toThrow('4 bytes');
    stdin.write('12345');
    await rejected;
    expect(stdin.destroyed).toBe(true);
    expect(stdin.listenerCount('data')).toBe(0);
  });

  it('bounds waiting for EOF even after data has arrived', async () => {
    const stdin = new PassThrough();
    const result = createJsonArgumentReader({ stdin, timeoutMs: 20 })('-', 'request');
    const rejected = expect(result).rejects.toThrow('timed out');
    stdin.write('{}');
    await rejected;
    expect(stdin.destroyed).toBe(true);
    expect(stdin.listenerCount('data')).toBe(0);
  });

  it('rejects premature close and stream errors without reflecting their messages', async () => {
    for (const error of [undefined, new Error('PRIVATE-PATH')]) {
      const stdin = new PassThrough();
      const result = createJsonArgumentReader({ stdin })('-', 'request');
      const rejected = expect(result).rejects.toThrow('Could not read request');
      stdin.destroy(error);
      await rejected;
    }
  });

  it('does not read interactive stdin or permit two stdin consumers', async () => {
    const terminal = Object.assign(new PassThrough(), { isTTY: true });
    await expect(createJsonArgumentReader({ stdin: terminal })('-', 'request')).rejects.toThrow(
      'pipe'
    );
    expect(terminal.listenerCount('data')).toBe(0);
    terminal.destroy();
    const read = createJsonArgumentReader({ stdin: Readable.from(['{}']) });
    await read('-', 'request');
    await expect(read('-', 'policy')).rejects.toThrow('once');
  });

  it('reads regular files with the same byte ceiling and sanitizes file failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-json-input-'));
    try {
      const file = join(dir, 'request.json');
      await writeFile(file, '{"a":1}');
      expect(await createJsonArgumentReader()(`@${file}`, 'request')).toEqual({ a: 1 });
      await expect(
        createJsonArgumentReader({ maxBytes: 4 })(`@${file}`, 'request')
      ).rejects.toThrow('4 bytes');
      await expect(createJsonArgumentReader()(`@${dir}`, 'request')).rejects.toThrow(
        'regular file'
      );
      await expect(createJsonArgumentReader()(`@${dir}/PRIVATE-PATH`, 'request')).rejects.toThrow(
        /^Could not read request\.$/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never echoes malformed private JSON in diagnostics', async () => {
    await expect(createJsonArgumentReader()('PRIVATE-VALUE', 'request')).rejects.toThrow(
      /^request must be valid JSON\.$/
    );
  });
});
