import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { FirefoxBiDiEngine } from '../../engine-firefox/src/index.js';
import { buildMcpServer } from '../../mcp-server/src/mcp-server.js';
import { AgentBrowserClient } from '../../sdk-typescript/src/client.js';
import { buildServer } from './server.js';

it('preserves Firefox policy refusal through REST, SDK and MCP without launching or falling back', async () => {
  const launch = vi.fn(async () => {
    throw new Error('Must refuse before launch');
  });
  const primary = new FakeEngine();
  const primaryCreate = vi.spyOn(primary, 'createSession');
  const firefox = new FirefoxBiDiEngine({ executablePath: '/missing/firefox', launch });
  const server = await buildServer({
    engine: primary,
    engines: { 'firefox-bidi': firefox },
    apiKeys: new Map([[createHash('sha256').update('owner-key').digest('hex'), 'owner']]),
  });
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: 'Bearer owner-key' },
      payload: {
        engine: 'firefox-bidi',
        controlMode: 'delegated',
        policy: { allowedHosts: ['*'], allowServiceWorkers: true },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: 'ENGINE_UNSUPPORTED',
        retryable: false,
        details: { reason: 'EGRESS_UNSUPPORTED' },
      },
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const client = new AgentBrowserClient({
      baseUrl: `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`,
      apiKey: 'owner-key',
    });
    await expect(client.sessions.create({ engine: 'firefox-bidi' })).rejects.toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
      retryable: false,
      details: { reason: 'EGRESS_UNSUPPORTED' },
    });
    const mcp = buildMcpServer({ createClient: () => client });
    const result = JSON.parse(
      (await mcp.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'gate',
          method: 'tools/call',
          params: {
            name: 'browser_create',
            arguments: { tenantId: 'owner', engine: 'firefox-bidi' },
          },
        })
      ))!
    );
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain('ENGINE_UNSUPPORTED');
    expect(launch).not.toHaveBeenCalled();
    expect(primaryCreate).not.toHaveBeenCalled();
    const sessions = await server.inject({
      url: '/v1/sessions',
      headers: { authorization: 'Bearer owner-key' },
    });
    expect(sessions.json()).toEqual({ sessions: [] });
  } finally {
    await server.close();
  }
});
