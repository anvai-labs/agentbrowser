import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { AgentBrowserClient } from './client.js';

describe('complete HTTP deadline and error envelope', () => {
  it.each([200, 403])('times out during a slow %s response body', async (status) => {
    const server = createServer((_request, response) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.flushHeaders();
      const timer = setTimeout(() => response.end('{}'), 500);
      response.on('close', () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing address');
      const client = new AgentBrowserClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        timeout: 100,
      });
      await expect(client.sessions.get('test')).rejects.toMatchObject({
        code: 'TIMEOUT',
        retryable: false,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
