import { once } from 'node:events';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { type Server, type Socket, isIP, createServer as tcpServer } from 'node:net';
import { type TLSSocket, connect as connectTls } from 'node:tls';
import { NetworkPolicy } from '@agentbrowser/policy';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ConnectionAuthority,
  ConnectionBudget,
  type ConnectionLease,
} from './connection-authority.js';
import { certificates } from './test-support/tls-fixture.js';

let key: string;
let cert: string;
let wrongIpCert: string;
beforeAll(() => {
  ({ key, cert, wrongIpCert } = certificates());
});

async function listen(server: Server) {
  const sockets = new Set<Socket>();
  let accepts = 0;
  server.on('connection', (socket) => {
    accepts += 1;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  return {
    port: address.port,
    sockets,
    get accepts() {
      return accepts;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

function authority() {
  const budget = new ConnectionBudget();
  const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
  const authority = new ConnectionAuthority(
    { policy: new NetworkPolicy(), admission: budget.createSessionScope() },
    { resolve }
  );
  return { authority, budget, resolve };
}

function destination(hostname: string, port: number, scheme = 'https') {
  return { kind: 'request' as const, hostname, port, url: `${scheme}://${hostname}:${port}/file` };
}

/** Test-only caller adapter. T2b2 must integrate and test this ownership itself. */
function tlsCaller(lease: ConnectionLease, ca: string) {
  lease.signal.throwIfAborted();
  const host = lease.destination.hostname;
  const tls = connectTls({
    socket: lease.socket,
    host,
    ca,
    ...(isIP(host) ? {} : { servername: host }),
  });
  const abort = () => tls.destroy();
  lease.signal.addEventListener('abort', abort, { once: true });
  tls.once('close', () => {
    lease.signal.removeEventListener('abort', abort);
    lease.close();
  });
  // Consumers below await the error; keep late cleanup errors from becoming an
  // unhandled event after secureConnect. This adapter does not publish outcomes.
  tls.on('error', () => {});
  if (lease.signal.aborted) abort();
  return tls;
}

async function get(socket: Socket, host: string): Promise<string> {
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  const end = once(socket, 'end');
  socket.write(`GET /file HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  await end;
  return Buffer.concat(chunks).toString();
}

describe('connection authority real TCP/HTTP/TLS contract', () => {
  it('preserves HTTP Host on independently resolved, unpooled TCP leases', async () => {
    const hosts: string[] = [];
    const fixture = await listen(
      httpServer((request, response) => {
        hosts.push(request.headers.host ?? '');
        response.end('fixture');
      })
    );
    const h = authority();
    try {
      for (let i = 0; i < 2; i += 1) {
        const lease = await h.authority.connect(
          destination('download.invalid', fixture.port, 'http'),
          { deadline: performance.now() + 10_000 }
        );
        expect(await get(lease.socket, `download.invalid:${fixture.port}`)).toContain('fixture');
        lease.close();
        await lease.closed;
      }
      expect(hosts).toEqual([
        `download.invalid:${fixture.port}`,
        `download.invalid:${fixture.port}`,
      ]);
      expect(fixture.accepts).toBe(2);
      expect(h.resolve).toHaveBeenCalledTimes(2);
      expect(h.budget.inUse).toBe(0);
    } finally {
      h.authority.revoke();
      await h.authority.closed;
      await fixture.close();
    }
  });

  it.each(['download.invalid', '127.0.0.1'])(
    'verifies TLS identity and Host for %s without replacing the logical host with its dial IP',
    async (hostname) => {
      const hosts: string[] = [];
      const names: Array<string | false> = [];
      const server = httpsServer({ key, cert }, (request, response) => {
        hosts.push(request.headers.host ?? '');
        response.end('tls fixture');
      });
      server.on('secureConnection', (socket) => names.push((socket as TLSSocket).servername));
      const fixture = await listen(server);
      const h = authority();
      try {
        const lease = await h.authority.connect(destination(hostname, fixture.port), {
          deadline: performance.now() + 10_000,
        });
        const tls = tlsCaller(lease, cert);
        await once(tls, 'secureConnect');
        expect(tls.authorized).toBe(true);
        expect(await get(tls, `${hostname}:${fixture.port}`)).toContain('tls fixture');
        tls.destroy();
        await lease.closed;
        expect(names).toEqual([hostname === 'download.invalid' ? hostname : false]);
        expect(hosts).toEqual([`${hostname}:${fixture.port}`]);
        expect(fixture.accepts).toBe(1);
        expect(h.resolve).toHaveBeenCalledTimes(hostname === 'download.invalid' ? 1 : 0);
        expect(h.budget.inUse).toBe(0);
      } finally {
        h.authority.revoke();
        await h.authority.closed;
        await fixture.close();
      }
    }
  );

  it.each(['dns', 'ip'])(
    'rejects a trusted certificate with the wrong %s identity before HTTP',
    async (mode) => {
      let requests = 0;
      const trusted = mode === 'ip' ? wrongIpCert : cert;
      const fixture = await listen(
        httpsServer({ key, cert: trusted }, (_request, response) => {
          requests += 1;
          response.end('unexpected');
        })
      );
      const h = authority();
      try {
        const lease = await h.authority.connect(
          destination(mode === 'ip' ? '127.0.0.1' : 'other.invalid', fixture.port),
          { deadline: performance.now() + 10_000 }
        );
        const tls = tlsCaller(lease, trusted);
        await expect(once(tls, 'secureConnect')).rejects.toMatchObject({
          code: 'ERR_TLS_CERT_ALTNAME_INVALID',
        });
        await lease.closed;
        expect(tls.destroyed).toBe(true);
        expect(fixture.accepts).toBe(1);
        expect(requests).toBe(0);
        expect(h.budget.inUse).toBe(0);
      } finally {
        h.authority.revoke();
        await h.authority.closed;
        await fixture.close();
      }
    }
  );

  it('denies mixed DNS before any TCP accept, and revokes a delivered lease before HTTP', async () => {
    let requests = 0;
    const fixture = await listen(
      httpServer((_request, response) => {
        requests += 1;
        response.end('unexpected');
      })
    );
    const budget = new ConnectionBudget();
    const denied = new ConnectionAuthority(
      {
        admission: budget.createSessionScope(),
        policy: new NetworkPolicy({ blockLoopback: true }),
      },
      {
        resolve: async () => [
          { address: '127.0.0.1', family: 4 },
          { address: '93.184.216.34', family: 4 },
        ],
      }
    );
    const allowed = authority();
    try {
      await expect(
        denied.connect(destination('download.invalid', fixture.port, 'http'), {
          deadline: performance.now() + 10_000,
        })
      ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(fixture.accepts).toBe(0);
      expect(requests).toBe(0);
      const lease = await allowed.authority.connect(
        destination('download.invalid', fixture.port, 'http'),
        { deadline: performance.now() + 10_000 }
      );
      allowed.authority.revoke();
      await allowed.authority.closed;
      expect(lease.socket.destroyed).toBe(true);
      expect(lease.signal.aborted).toBe(true);
      expect(requests).toBe(0);
    } finally {
      denied.revoke();
      allowed.authority.revoke();
      await Promise.all([denied.closed, allowed.authority.closed]);
      await fixture.close();
    }
  });

  it.each(['revoke', 'caller', 'deadline'])(
    'closes raw, TLS and upstream sockets during a stalled handshake on %s',
    async (mode) => {
      let onHello!: () => void;
      const hello = new Promise<void>((resolve) => {
        onHello = resolve;
      });
      const server = tcpServer((socket) => socket.once('data', () => onHello()));
      const fixture = await listen(server);
      const h = authority();
      const controller = new AbortController();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      try {
        const lease = await h.authority.connect(destination('download.invalid', fixture.port), {
          deadline: performance.now() + 100,
          signal: controller.signal,
        });
        const tls = tlsCaller(lease, cert);
        const tlsClosed = new Promise<void>((resolve) => tls.once('close', () => resolve()));
        await hello;
        if (mode === 'revoke') h.authority.revoke();
        else if (mode === 'caller') controller.abort();
        else await vi.advanceTimersByTimeAsync(101);
        await Promise.all([lease.closed, tlsClosed]);
        expect(lease.socket.destroyed).toBe(true);
        expect(tls.destroyed).toBe(true);
        expect(h.budget.inUse).toBe(0);
        vi.useRealTimers();
        await vi.waitFor(() => expect(fixture.sockets.size).toBe(0));
        expect(fixture.accepts).toBe(1);
      } finally {
        vi.useRealTimers();
        h.authority.revoke();
        await h.authority.closed;
        await fixture.close();
      }
    }
  );
});
