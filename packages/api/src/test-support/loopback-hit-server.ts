// Shared scaffold for the real-Chromium lane tests: a loopback HTTP fixture
// that buffers each request's body and hands the parsed facts to the test's
// own responder. The tests keep their domain logic; the boilerplate
// (server lifecycle, chunk collection, host/path extraction) lives once.
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LoopbackRequest {
  host: string;
  path: string;
  method: string;
  body: string;
  headers: IncomingMessage['headers'];
}

export async function startLoopbackHitServer(
  respond: (request: LoopbackRequest, res: ServerResponse, port: number) => void | Promise<void>
): Promise<{ port: number; close: () => Promise<void> }> {
  let port = 0;
  let server: Server;
  const fixture = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void respond(
        {
          host: req.headers.host?.split(':')[0] ?? '',
          path: req.url ?? '/',
          method: req.method ?? 'GET',
          body: Buffer.concat(chunks).toString(),
          headers: req.headers,
        },
        res,
        port
      );
    });
  });
  server = fixture;
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
