import { once } from 'node:events';
import { createServer as httpsServer } from 'node:https';
import { type Server, type Socket, createServer as tcpServer } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { NetworkPolicy } from '@agentbrowser/policy';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DownloadBudget, DownloadTransport } from './download-transport.js';
import { certificates } from './test-support/tls-fixture.js';

let trust: ReturnType<typeof certificates>;
beforeAll(() => {
  trust = certificates();
});
async function listen(server: Server) {
  const sockets = new Set<Socket>();
  let accepts = 0;
  server.on('connection', (socket) => {
    accepts++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  return {
    port: address.port,
    sockets,
    get accepts() {
      return accepts;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('production download TLS handoff', () => {
  it.each(['download.invalid', '127.0.0.1'])(
    'preserves identity, Host and DNS-only SNI for %s',
    async (hostname) => {
      const hosts: string[] = [];
      const names: Array<string | false> = [];
      const server = httpsServer(trust, (request, response) => {
        hosts.push(request.headers.host ?? '');
        expect(request.method).toBe('GET');
        response.end('secure download');
      });
      server.on('secureConnection', (socket) => names.push((socket as TLSSocket).servername));
      const fixture = await listen(server);
      const budget = new DownloadBudget();
      const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
      const transport = new DownloadTransport(
        { policy: new NetworkPolicy(), budget },
        { resolve, ca: trust.cert }
      );
      try {
        for (let index = 0; index < 2; index++) {
          const result = await transport.download(`https://${hostname}:${fixture.port}/file`, {
            maxBytes: 1024,
          });
          expect(Buffer.from(result.bytes).toString()).toBe('secure download');
        }
        expect(hosts).toEqual(Array(2).fill(`${hostname}:${fixture.port}`));
        expect(names).toEqual(Array(2).fill(hostname === 'download.invalid' ? hostname : false));
        expect(resolve).toHaveBeenCalledTimes(hostname === 'download.invalid' ? 2 : 0);
        expect(fixture.accepts).toBe(2);
        expect(budget.connections.inUse + budget.transfers.inUse).toBe(0);
      } finally {
        transport.revoke();
        await fixture.close();
      }
    }
  );

  it.each(['wrong.invalid', 'wrong-ip', 'untrusted'])(
    'rejects %s certificates before HTTP',
    async (mode) => {
      let requests = 0;
      const cert = mode === 'wrong-ip' ? trust.wrongIpCert : trust.cert;
      const fixture = await listen(
        httpsServer({ key: trust.key, cert }, (_request, response) => {
          requests++;
          response.end('unexpected');
        })
      );
      const budget = new DownloadBudget();
      const outcomes: unknown[] = [];
      const transport = new DownloadTransport(
        { policy: new NetworkPolicy(), budget, onOutcome: (event) => outcomes.push(event) },
        {
          resolve: async () => [{ address: '127.0.0.1', family: 4 }],
          ...(mode !== 'untrusted' ? { ca: cert } : {}),
        }
      );
      try {
        const hostname =
          mode === 'wrong-ip' ? '127.0.0.1' : mode === 'untrusted' ? 'download.invalid' : mode;
        const failure = await transport
          .download(`https://${hostname}:${fixture.port}/?token=private`, { maxBytes: 1024 })
          .catch((error) => error);
        expect(failure).toMatchObject({
          code: 'INTERNAL',
          retryable: false,
          details: { stage: 'tls' },
        });
        expect(fixture.accepts).toBe(1);
        expect(requests).toBe(0);
        expect(outcomes).toHaveLength(1);
        expect(JSON.stringify(outcomes)).not.toMatch(/private|invalid|CERT|127\.0\.0/);
        expect(budget.connections.inUse + budget.transfers.inUse).toBe(0);
      } finally {
        transport.revoke();
        await fixture.close();
      }
    }
  );

  it.each(['revoke', 'abort', 'deadline'])('closes stalled production TLS on %s', async (mode) => {
    let hello!: () => void;
    const contacted = new Promise<void>((resolve) => {
      hello = resolve;
    });
    const fixture = await listen(
      tcpServer((socket) =>
        socket.once('data', () => {
          socket.resume();
          hello();
        })
      )
    );
    const budget = new DownloadBudget();
    const controller = new AbortController();
    const transport = new DownloadTransport({ policy: new NetworkPolicy(), budget });
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const promise = transport.download(`https://127.0.0.1:${fixture.port}`, {
        maxBytes: 1024,
        timeoutMs: 2000,
        signal: controller.signal,
      });
      const rejected = expect(promise).rejects.toMatchObject({
        code: mode === 'deadline' ? 'ACTION_TIMEOUT' : 'INTERNAL',
      });
      await contacted;
      if (mode === 'revoke') transport.revoke();
      else if (mode === 'abort') controller.abort();
      else await vi.advanceTimersByTimeAsync(2001);
      await rejected;
      vi.useRealTimers();
      await vi.waitFor(() => {
        expect(fixture.sockets.size).toBe(0);
        expect(budget.connections.inUse + budget.transfers.inUse).toBe(0);
      });
    } finally {
      vi.useRealTimers();
      transport.revoke();
      await fixture.close();
    }
  });
});
