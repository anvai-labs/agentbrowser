import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { NetworkPolicy, SessionHostPolicy } from '@agentbrowser/policy';
import { describe, expect, it } from 'vitest';
import { downloadWithPolicy } from './download-transport.js';

describe('bounded download transport', () => {
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
