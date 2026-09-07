import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { NetworkPolicy, SessionHostPolicy } from '@agentbrowser/policy';
import { describe, expect, it, vi } from 'vitest';
import { downloadWithPolicy } from './download-transport.js';

describe('bounded download transport', () => {
  it('rejects every malformed resolver record before TCP, even without an address-policy hook', async () => {
    let accepts = 0;
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end('ok');
    });
    server.on('connection', () => {
      accepts += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = server.address();
      if (!endpoint || typeof endpoint === 'string') throw new Error('Missing address');
      const valid = { address: '127.0.0.1', family: 4 };
      const invalid: unknown[] = [
        null,
        undefined,
        {},
        { address: 127001, family: 4 },
        { address: 'not-an-ip', family: 4 },
        { address: '127.0.0.1', family: 6 },
        { address: '::ffff:127.0.0.1', family: 4 },
        { address: '::1', family: 0 },
        { address: '[::1]', family: 6 },
        { address: 'fe80::1%en0', family: 6 },
      ];
      const origin = `http://download.invalid:${endpoint.port}`;
      for (const bad of invalid) {
        for (const records of [
          [valid, bad],
          [bad, valid],
        ]) {
          // Exercise malformed runtime output despite the typed resolver port.
          const resolve = vi.fn(async () => records as Array<{ address: string; family: number }>);
          await expect(
            downloadWithPolicy(origin, {
              policy: { checkRequest: async () => {} },
              maxBytes: 1024,
              resolve,
            })
          ).rejects.toMatchObject({
            code: 'POLICY_DENIED',
            details: { rule: 'resolvedAddressInvalid' },
          });
          expect(resolve).toHaveBeenCalledOnce();
          expect(accepts).toBe(0);
          expect(requests).toBe(0);
        }
      }
      // The same live fixture is reachable when its complete answer set is valid.
      await downloadWithPolicy(origin, {
        policy: new NetworkPolicy(),
        maxBytes: 1024,
        resolve: async () => [valid],
      });
      expect(accepts).toBe(1);
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('blocks mapped loopback literals and DNS answers before TCP, while preserving permitted local access', async () => {
    let accepts = 0;
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end('ok');
    });
    server.on('connection', () => {
      accepts += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = server.address();
      if (!endpoint || typeof endpoint === 'string') throw new Error('Missing address');
      const strict = new NetworkPolicy({ blockLoopback: true });
      const mapped = { address: '::ffff:127.0.0.1', family: 6 };
      const resolve = vi.fn(async () => [mapped]);
      const literal = `http://[::ffff:127.0.0.1]:${endpoint.port}`;
      await expect(
        downloadWithPolicy(literal, { policy: strict, maxBytes: 1024, resolve })
      ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(resolve).not.toHaveBeenCalled();
      const named = `http://download.invalid:${endpoint.port}`;
      // Mapped first: any regression can only dial this owned loopback fixture.
      for (const records of [[mapped], [mapped, { address: '93.184.216.34', family: 4 }]]) {
        await expect(
          downloadWithPolicy(named, {
            policy: strict,
            maxBytes: 1024,
            resolve: async () => records,
          })
        ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      }
      expect(accepts).toBe(0);
      expect(requests).toBe(0);
      await downloadWithPolicy(named, { policy: new NetworkPolicy(), maxBytes: 1024, resolve });
      await downloadWithPolicy(literal, { policy: new NetworkPolicy(), maxBytes: 1024 });
      expect(accepts).toBe(2);
      expect(requests).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('honors the composed policy redirect limit before contacting the next hop', async () => {
    const hits: string[] = [];
    const server = createServer((request, response) => {
      hits.push(request.url ?? '');
      response.writeHead(302, { location: '/next' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing address');
      await expect(
        downloadWithPolicy(`http://127.0.0.1:${address.port}/start`, {
          policy: new SessionHostPolicy(new NetworkPolicy({ maxRedirects: 0 }), {}),
          maxBytes: 1024,
        })
      ).rejects.toMatchObject({ code: 'MAX_REDIRECTS' });
      expect(hits).toEqual(['/start']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('pins validated DNS results and rechecks redirect hosts', async () => {
    const hosts: string[] = [];
    const server = createServer((request, response) => {
      hosts.push(request.headers.host ?? '');
      if (request.url === '/redirect') {
        response.writeHead(302, { location: 'http://blocked.invalid/private' });
        response.end();
      } else response.end('download');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing address');
      let resolutions = 0;
      const options = {
        policy: new SessionHostPolicy(new NetworkPolicy(), { allowedHosts: ['download.invalid'] }),
        maxBytes: 1024,
        resolve: async () => {
          resolutions += 1;
          return [{ address: '127.0.0.1', family: 4 }];
        },
      };
      const origin = `http://download.invalid:${address.port}`;
      expect(Buffer.from((await downloadWithPolicy(origin, options)).bytes).toString()).toBe(
        'download'
      );
      expect(hosts).toEqual([`download.invalid:${address.port}`]);
      await expect(downloadWithPolicy(`${origin}/redirect`, options)).rejects.toMatchObject({
        code: 'POLICY_DENIED',
      });
      expect(resolutions).toBe(2);
      expect(hosts).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['chunked', 'compressed', 'slow'])('bounds %s bodies', async (mode) => {
    const server = createServer((_request, response) => {
      if (mode === 'compressed') {
        response.setHeader('content-encoding', 'gzip');
        response.end(gzipSync('x'.repeat(8192)));
      } else if (mode === 'chunked') {
        response.write('x'.repeat(2048));
        response.end('more');
      } else {
        response.writeHead(200);
        response.flushHeaders();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing address');
      await expect(
        downloadWithPolicy(`http://127.0.0.1:${address.port}`, {
          policy: new NetworkPolicy(),
          maxBytes: 1024,
          // Only the stalled-body case tests timeouts. Size-limit cases
          // must tolerate scheduling contention in the full browser suite.
          timeoutMs: mode === 'slow' ? 100 : 5000,
        })
      ).rejects.toMatchObject({ code: mode === 'slow' ? 'ACTION_TIMEOUT' : 'DOWNLOAD_BLOCKED' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
