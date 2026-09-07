import { lookup } from 'node:dns/promises';
import { type IncomingMessage, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { EngineError, type RequestPolicy } from '@agentbrowser/engine';

export interface DownloadTransportOptions {
  policy: RequestPolicy;
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  resolve?(hostname: string): Promise<Array<{ address: string; family: number }>>;
}

/** Bounded direct-download transport: validate every hop and pin its TCP address. */
export async function downloadWithPolicy(
  url: string,
  options: DownloadTransportOptions
): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
    throw new EngineError('INVALID_REQUEST', 'maxBytes must be a positive safe integer');
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new EngineError('ACTION_TIMEOUT', 'Download deadline exceeded')),
    options.timeoutMs ?? 30_000
  );
  let onAbort: () => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });

  const transfer = async () => {
    let current = new URL(url);
    const visited = new Set<string>();
    const redirects: Array<{ url: string; hostname: string }> = [];
    for (let hop = 0; ; hop += 1) {
      controller.signal.throwIfAborted();
      if (hop > (options.maxRedirects ?? 10) || visited.has(current.href))
        throw new EngineError('POLICY_DENIED', 'Download redirect limit or loop', false, {
          rule: 'redirects',
        });
      visited.add(current.href);
      if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password)
        throw new EngineError(
          'POLICY_DENIED',
          'Downloads require an http(s) URL without embedded credentials'
        );
      await options.policy.checkRequest({ hostname: current.hostname, url: current.href });
      const hostname = current.hostname.replace(/^\[|\]$/g, '');
      const family = isIP(hostname);
      const addresses = family
        ? [{ address: hostname, family }]
        : await (options.resolve ?? ((name) => lookup(name, { all: true })))(hostname);
      if (!addresses.length)
        throw new EngineError('POLICY_DENIED', 'Download hostname did not resolve');
      // Validate the entire answer set before selection, even for a custom
      // policy without an address hook. Mapped IPv4 remains family 6 on the wire.
      for (const entry of addresses) {
        if (
          !entry ||
          typeof entry.address !== 'string' ||
          entry.address.includes('%') ||
          (entry.family !== 4 && entry.family !== 6) ||
          isIP(entry.address) !== entry.family
        ) {
          throw new EngineError('POLICY_DENIED', 'Invalid resolved download address', false, {
            rule: 'resolvedAddressInvalid',
          });
        }
      }
      await options.policy.checkResolvedAddresses?.(addresses.map((entry) => entry.address));
      controller.signal.throwIfAborted();
      const pinned = addresses[0];
      if (!pinned) throw new EngineError('POLICY_DENIED', 'No validated download address');
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = (current.protocol === 'https:' ? httpsRequest : httpRequest)(
          current,
          {
            agent: false,
            signal: controller.signal,
            family: pinned.family,
            lookup: (_hostname, _lookupOptions, callback) =>
              callback(null, pinned.address, pinned.family),
            headers: { 'accept-encoding': 'identity' },
          },
          resolve
        );
        request.once('error', reject);
        request.end();
      });
      try {
        const headers = Object.fromEntries(
          Object.entries(response.headers)
            .filter((entry) => entry[1] !== undefined)
            .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)])
        );
        await options.policy.checkResponse?.({ headers });
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          current = new URL(response.headers.location, current);
          redirects.push({ url: current.href, hostname: current.hostname });
          await options.policy.checkRedirectChain?.(redirects);
          continue;
        }
        if (status < 200 || status >= 300)
          throw new EngineError('INTERNAL', `Download failed: HTTP ${status}`);
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > options.maxBytes)
          throw new EngineError('DOWNLOAD_BLOCKED', 'Download exceeds the session byte limit');
        const encoding = response.headers['content-encoding']?.toLowerCase();
        const decoder =
          encoding === 'gzip'
            ? createGunzip()
            : encoding === 'deflate'
              ? createInflate()
              : encoding === 'br'
                ? createBrotliDecompress()
                : undefined;
        if (encoding && encoding !== 'identity' && !decoder)
          throw new EngineError('DOWNLOAD_BLOCKED', 'Unsupported download content encoding');
        const stream = decoder ? response.pipe(decoder) : response;
        if (decoder) response.once('error', (error) => decoder.destroy(error));
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          for await (const chunk of stream) {
            controller.signal.throwIfAborted();
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.byteLength;
            if (size > options.maxBytes)
              throw new EngineError('DOWNLOAD_BLOCKED', 'Download exceeds the session byte limit');
            await options.policy.checkBodySize?.(size);
            chunks.push(bytes);
          }
          return {
            bytes: Buffer.concat(chunks, size),
            contentType: headers['content-type'] ?? 'application/octet-stream',
          };
        } finally {
          decoder?.destroy();
        }
      } finally {
        response.destroy();
      }
    }
  };
  try {
    return await Promise.race([transfer(), deadline]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
