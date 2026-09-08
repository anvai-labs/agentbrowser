/** Native release-runtime acceptance: the production HTTP/TLS socket handoff. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type RequestListener, createServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { DownloadBudget, DownloadTransport } from '../packages/api/dist/download-transport.js';
import { certificates } from '../packages/api/src/test-support/tls-fixture.js';
import { NetworkPolicy } from '../packages/policy/dist/index.js';

const trust = certificates();
for (const secure of [false, true]) {
  for (const abort of [false, true]) {
    let contacted!: () => void;
    const contact = new Promise<void>((resolve) => {
      contacted = resolve;
    });
    const hosts: string[] = [];
    const handler: RequestListener = (request, response) => {
      hosts.push(request.headers.host ?? '');
      response.writeHead(200);
      response.flushHeaders();
      if (!abort) response.end('native download');
      contacted();
    };
    const server = secure ? httpsServer(trust, handler) : createServer(handler);
    const sockets = new Set<Socket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
    });
    const ready = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await ready;
    const address = server.address();
    assert(address && typeof address !== 'string');
    const budget = new DownloadBudget(1);
    const controller = new AbortController();
    let resolutions = 0;
    const transport = new DownloadTransport(
      { policy: new NetworkPolicy(), budget },
      {
        resolve: async () => {
          resolutions++;
          return [{ address: '127.0.0.1', family: 4 }];
        },
        ca: trust.cert,
      }
    );
    try {
      const result = transport.download(
        `${secure ? 'https' : 'http'}://download.invalid:${address.port}/`,
        { maxBytes: 1024, timeoutMs: 5000, signal: controller.signal }
      );
      if (abort) {
        const rejected = assert.rejects(result, { code: 'INTERNAL' });
        await Promise.race([contact, result]);
        controller.abort();
        await rejected;
      } else assert.equal(Buffer.from((await result).bytes).toString(), 'native download');
      const deadline = performance.now() + 2000;
      while (
        (budget.connections.inUse || budget.transfers.inUse || sockets.size) &&
        performance.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(budget.connections.inUse + budget.transfers.inUse + sockets.size, 0);
      assert.equal(resolutions, 1);
      assert.deepEqual(hosts, [`download.invalid:${address.port}`]);
      console.log(`${secure ? 'HTTPS' : 'HTTP'} ${abort ? 'abort' : 'positive'}: passed`);
    } finally {
      transport.revoke();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
