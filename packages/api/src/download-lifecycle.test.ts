import { createServer } from 'node:http';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { NetworkPolicy } from '@agentbrowser/policy';
import { describe, expect, it, vi } from 'vitest';
import { DownloadBudget, DownloadTransport } from './download-transport.js';

describe('download ownership', () => {
  it('aborts encoded overflow while body policy is stalled, retaining only callback admission', async () => {
    let entered!: () => void;
    let resume!: () => void;
    let overflow!: () => void;
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let upstreamClosed = false;
    const server = createServer((_request, response) => {
      response.setHeader('content-encoding', 'gzip');
      response.write(gzipSync('ok'));
      response.socket?.once('close', () => {
        upstreamClosed = true;
      });
      overflow = () => {
        const encoded = gzipSync('more');
        const header = Buffer.from(encoded.subarray(0, 10));
        header[3] = 8;
        response.write(
          Buffer.concat([header, Buffer.alloc(4096, 65), Buffer.from([0]), encoded.subarray(10)])
        );
      };
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const policy = new NetworkPolicy();
    vi.spyOn(policy, 'checkBodySize').mockImplementation(async () => {
      entered();
      await pending;
    });
    const budget = new DownloadBudget(1);
    const transport = new DownloadTransport({ policy, budget });
    let outcome: unknown;
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing address');
      const result = transport.download(`http://127.0.0.1:${address.port}`, { maxBytes: 1024 });
      void result.then(
        (value) => {
          outcome = value;
        },
        (error) => {
          outcome = error;
        }
      );
      await called;
      overflow();
      await vi.waitFor(() => {
        expect(outcome).toMatchObject({ code: 'DOWNLOAD_BLOCKED' });
        expect(upstreamClosed).toBe(true);
        expect(budget.connections.inUse).toBe(0);
      });
      expect(budget.transfers.inUse).toBe(1);
      resume();
      await vi.waitFor(() => expect(budget.transfers.inUse).toBe(0));
    } finally {
      resume();
      transport.revoke();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each(['gzip', 'deflate', 'br'])(
    'completes buffered %s bodies after normal TCP close',
    async (encoding) => {
      const payload = 'a successful compressed download'.repeat(30);
      const compress =
        encoding === 'gzip' ? gzipSync : encoding === 'br' ? brotliCompressSync : deflateSync;
      const server = createServer((_request, response) => {
        response.setHeader('content-encoding', encoding);
        response.end(compress(payload));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const policy = new NetworkPolicy();
      const budget = new DownloadBudget(1);
      vi.spyOn(policy, 'checkBodySize').mockImplementation(async () => {
        await vi.waitFor(() => expect(budget.connections.inUse).toBe(0));
      });
      const transport = new DownloadTransport({ policy, budget, maxConnections: 1 });
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing address');
        const result = await transport.download(`http://127.0.0.1:${address.port}`, {
          maxBytes: 4096,
        });
        expect(Buffer.from(result.bytes).toString()).toBe(payload);
        expect(budget.transfers.inUse).toBe(0);
      } finally {
        transport.revoke();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );

  it('drains each redirect lease before readmission and rechecks changing DNS', async () => {
    const hits: string[] = [];
    const server = createServer((request, response) => {
      hits.push(request.url ?? '');
      if (request.url === '/end') response.end('done');
      else {
        response.writeHead(302, { location: request.url === '/start' ? '/middle' : '/end' });
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const budget = new DownloadBudget(1);
    const policy = new NetworkPolicy();
    const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    const gate = vi.spyOn(policy, 'checkResolvedAddresses');
    const transport = new DownloadTransport({ policy, budget, maxConnections: 1 }, { resolve });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing address');
      const url = `http://download.invalid:${address.port}/start`;
      expect(
        Buffer.from((await transport.download(url, { maxBytes: 1024 })).bytes).toString()
      ).toBe('done');
      expect(hits).toEqual(['/start', '/middle', '/end']);
      expect(resolve).toHaveBeenCalledTimes(3);
      expect(gate).toHaveBeenCalledTimes(3);
      resolve.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]).mockResolvedValueOnce([
        { address: '127.0.0.1', family: 4 },
        { address: 'invalid', family: 4 },
      ]);
      await expect(transport.download(url, { maxBytes: 1024 })).rejects.toMatchObject({
        code: 'POLICY_DENIED',
      });
      expect(hits).toEqual(['/start', '/middle', '/end', '/start']);
      expect(budget.connections.inUse + budget.transfers.inUse).toBe(0);
    } finally {
      transport.revoke();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    'status',
    'encoding',
    'invalid-gzip',
    'response-policy',
    'body-policy',
    'declared-size',
    'encoded-size',
  ])('restores admission after %s refusal', async (mode) => {
    const server = createServer((_request, response) => {
      if (mode === 'status') response.writeHead(503);
      if (mode === 'encoding') response.setHeader('content-encoding', 'unknown');
      if (mode === 'invalid-gzip' || mode === 'encoded-size')
        response.setHeader('content-encoding', 'gzip');
      if (mode === 'declared-size') response.setHeader('content-length', '5000');
      if (mode === 'encoded-size') {
        // Valid gzip with a large optional filename; tiny decoded payload.
        const encoded = gzipSync('ok');
        const header = Buffer.from(encoded.subarray(0, 10));
        header[3] = 8;
        response.write(
          Buffer.concat([header, Buffer.alloc(2048, 65), Buffer.from([0]), encoded.subarray(10)])
        );
        response.end();
      } else response.end('body');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const budget = new DownloadBudget(1);
    const policy = new NetworkPolicy();
    if (mode === 'response-policy')
      vi.spyOn(policy, 'checkResponse').mockRejectedValue({
        code: 'POLICY_DENIED',
        secret: 'private',
      });
    if (mode === 'body-policy')
      vi.spyOn(policy, 'checkBodySize').mockRejectedValue({
        code: 'POLICY_DENIED',
        secret: 'private',
      });
    const transport = new DownloadTransport({ policy, budget });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing address');
      const failure = await transport
        .download(`http://127.0.0.1:${address.port}`, { maxBytes: 1024 })
        .catch((error) => error);
      expect(failure).toHaveProperty(
        'code',
        mode.includes('policy')
          ? 'POLICY_DENIED'
          : mode === 'status' || mode === 'invalid-gzip'
            ? 'INTERNAL'
            : 'DOWNLOAD_BLOCKED'
      );
      await vi.waitFor(() => expect(budget.connections.inUse + budget.transfers.inUse).toBe(0));
      expect(JSON.stringify(failure)).not.toContain('private');
    } finally {
      transport.revoke();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not reset the overall deadline at redirect or async policy boundaries', async () => {
    let resume!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hits: string[] = [];
    const server = createServer((request, response) => {
      hits.push(request.url ?? '');
      response.writeHead(302, { location: '/next' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const policy = new NetworkPolicy();
    vi.spyOn(policy, 'checkRedirectChain').mockImplementation(async () => {
      entered();
      await pending;
    });
    const budget = new DownloadBudget();
    const transport = new DownloadTransport({ policy, budget });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing address');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const result = transport.download(`http://127.0.0.1:${address.port}/start`, {
        maxBytes: 1024,
        timeoutMs: 2000,
      });
      const rejected = expect(result).rejects.toMatchObject({ code: 'ACTION_TIMEOUT' });
      await called;
      await vi.advanceTimersByTimeAsync(2001);
      await rejected;
      expect(budget.transfers.inUse).toBe(1);
      resume();
      vi.useRealTimers();
      await vi.waitFor(() => expect(budget.connections.inUse + budget.transfers.inUse).toBe(0));
      expect(hits).toEqual(['/start']);
    } finally {
      vi.useRealTimers();
      resume();
      transport.revoke();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, 1.5])(
    'rejects invalid timing %s before policy/DNS',
    async (timeoutMs) => {
      const policy = new NetworkPolicy();
      const check = vi.spyOn(policy, 'checkRequest');
      const transport = new DownloadTransport({ policy, budget: new DownloadBudget() });
      try {
        await expect(
          transport.download('http://download.invalid', { maxBytes: 1024, timeoutMs })
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        expect(check).not.toHaveBeenCalled();
      } finally {
        transport.revoke();
      }
    }
  );
  it('revokes a stalled response immediately and restores admission', async () => {
    let contacted!: () => void;
    const contact = new Promise<void>((resolve) => {
      contacted = resolve;
    });
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      contacted();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const budget = new DownloadBudget();
    const transport = new DownloadTransport({ policy: new NetworkPolicy(), budget });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing address');
      const result = transport.download(`http://127.0.0.1:${address.port}`, { maxBytes: 1024 });
      const rejected = expect(result).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
      await contact;
      transport.revoke({ code: 'SESSION_NOT_FOUND' });
      await rejected;
      await vi.waitFor(() => expect(budget.transfers.inUse + budget.connections.inUse).toBe(0));
    } finally {
      transport.revoke();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('holds cancelled asynchronous response callbacks against the runtime budget', async () => {
    let finish!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const policy = new NetworkPolicy();
    vi.spyOn(policy, 'checkResponse').mockImplementation(async () => {
      entered();
      await pending;
    });
    const server = createServer((_request, response) => response.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const budget = new DownloadBudget(1);
    const first = new DownloadTransport({ policy, budget });
    const second = new DownloadTransport({ policy: new NetworkPolicy(), budget });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing address');
      const url = `http://127.0.0.1:${address.port}`;
      const result = first.download(url, { maxBytes: 1024 });
      const rejected = expect(result).rejects.toMatchObject({ code: 'INTERNAL' });
      await called;
      first.revoke();
      await rejected;
      expect(budget.transfers.inUse).toBe(1);
      await expect(second.download(url, { maxBytes: 1024 })).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      });
      finish();
      await vi.waitFor(() => expect(budget.transfers.inUse).toBe(0));
      expect(Buffer.from((await second.download(url, { maxBytes: 1024 })).bytes).toString()).toBe(
        'ok'
      );
    } finally {
      finish();
      first.revoke();
      second.revoke();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
