import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { NetworkPolicy } from '@agentbrowser/policy';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionAuthority, ConnectionBudget } from './connection-authority.js';
import { DownloadBudget, DownloadTransport } from './download-transport.js';

describe('request and destination consumers share one TCP owner', () => {
  it.each([{ maxDnsAnswers: 17 }, { setupTimeoutMs: 10_001 }])(
    'does not widen the selected safety ceiling: %j',
    (limits) => {
      expect(
        () =>
          new ConnectionAuthority({
            mode: 'tunnel',
            policy: new NetworkPolicy().snapshotForGateway().destinationPolicy,
            admission: new ConnectionBudget().createSessionScope(),
            ...limits,
          })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    }
  );
  it('admits seven real downloads plus one tunnel, denies the ninth before policy/DNS, and preserves downloads on rotation', async () => {
    const budget = new DownloadBudget();
    const admission = budget.connections.createSessionScope();
    const sockets = new Set<Socket>();
    let accepts = 0;
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200);
      response.flushHeaders();
    });
    server.on('connection', (socket) => {
      accepts++;
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const pair = new NetworkPolicy().snapshotForGateway({ allowedPorts: [address.port] });
    const checkDestination = vi.fn(pair.destinationPolicy.checkDestination);
    const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    const transport = new DownloadTransport(
      { policy: pair.requestPolicy, budget, admission },
      { resolve }
    );
    const makeTunnel = () =>
      new ConnectionAuthority(
        {
          mode: 'tunnel',
          policy: { ...pair.destinationPolicy, checkDestination },
          admission,
        },
        { resolve }
      );
    const first = makeTunnel();
    const replacement = makeTunnel();
    const target = { kind: 'tunnel' as const, hostname: 'download.invalid', port: address.port };
    const pending = Array.from({ length: 7 }, () =>
      transport
        .download(`http://download.invalid:${address.port}/actual-path`, { maxBytes: 1024 })
        .catch((error) => error)
    );
    try {
      await vi.waitFor(() => expect(requests).toBe(7));
      const lease = await first.connect(target, { deadline: performance.now() + 30_000 });
      await vi.waitFor(() => expect(accepts).toBe(8));
      expect(lease.destination).toEqual(target);
      expect(checkDestination).toHaveBeenCalledWith({
        hostname: 'download.invalid',
        port: address.port,
      });
      expect(admission.inUse).toBe(8);
      await expect(
        replacement.connect(target, { deadline: performance.now() + 30_000 })
      ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
      expect(resolve).toHaveBeenCalledTimes(8);
      expect(checkDestination).toHaveBeenCalledTimes(1);
      first.revoke();
      await first.closed;
      expect(admission.inUse).toBe(7);
      expect(budget.transfers.inUse).toBe(7);
      const next = await replacement.connect(target, { deadline: performance.now() + 30_000 });
      expect(next.socket.destroyed).toBe(false);
      expect(requests).toBe(7); // no fabricated HTTP request in tunnel mode
      admission.closeAdmission();
      await expect(
        transport.download(`http://download.invalid:${address.port}/later`, { maxBytes: 1024 })
      ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    } finally {
      first.revoke();
      replacement.revoke();
      transport.revoke();
      await Promise.all([first.closed, replacement.closed, ...pending]);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(admission.inUse + budget.connections.inUse + budget.transfers.inUse).toBe(0);
  });

  it('retains cancelled DNS ownership across replacement and releases only after settlement', async () => {
    const runtime = new ConnectionBudget();
    const admission = runtime.createSessionScope(1);
    let finish!: (answers: Array<{ address: string; family: number }>) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stalled = new Promise<Array<{ address: string; family: number }>>((resolve) => {
      finish = resolve;
    });
    const policy = new NetworkPolicy().snapshotForGateway().destinationPolicy;
    const old = new ConnectionAuthority(
      { mode: 'tunnel', policy, admission },
      {
        resolve: () => {
          entered();
          return stalled;
        },
      }
    );
    const resolve = vi.fn(async () => []);
    const next = new ConnectionAuthority({ mode: 'tunnel', policy, admission }, { resolve });
    const target = { kind: 'tunnel' as const, hostname: 'example.com', port: 443 };
    const pending = old.connect(target, { deadline: performance.now() + 30_000 }).catch((e) => e);
    await started;
    old.revoke();
    expect(await pending).toMatchObject({ code: 'INTERNAL' });
    await expect(
      next.connect(target, { deadline: performance.now() + 30_000 })
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(resolve).not.toHaveBeenCalled();
    expect(admission.inUse).toBe(1);
    finish([]);
    await old.closed;
    expect(admission.inUse + runtime.inUse).toBe(0);
    await expect(
      next.connect(target, { deadline: performance.now() + 30_000 })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(resolve).toHaveBeenCalledOnce();
    next.revoke();
    await next.closed;
  });

  it('rejects mode mismatch and URL-bearing tunnel input before callbacks or admission', async () => {
    const runtime = new ConnectionBudget();
    const admission = runtime.createSessionScope();
    const pair = new NetworkPolicy().snapshotForGateway();
    const resolve = vi.fn(async () => []);
    const request = new ConnectionAuthority(
      { mode: 'request', policy: pair.requestPolicy, admission },
      { resolve }
    );
    const tunnel = new ConnectionAuthority(
      { mode: 'tunnel', policy: pair.destinationPolicy, admission },
      { resolve }
    );
    for (const [authority, input] of [
      [request, { kind: 'tunnel', hostname: 'example.com', port: 443 }],
      [
        tunnel,
        { kind: 'request', url: 'https://example.com/private', hostname: 'example.com', port: 443 },
      ],
      [
        tunnel,
        { kind: 'tunnel', url: 'https://example.com/private', hostname: 'example.com', port: 443 },
      ],
    ] as const) {
      await expect(
        authority.connect(input, { deadline: performance.now() + 30_000 })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(runtime.inUse).toBe(0);
    request.revoke();
    tunnel.revoke();
    await Promise.all([request.closed, tunnel.closed]);
  });
});
