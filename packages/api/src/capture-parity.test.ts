import { ArtifactRefSchema, PageStateSchema } from '@agentbrowser/protocol';
import { FakeEngine } from '@agentbrowser/testkit';
import Ajv2020 from 'ajv/dist/2020';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCli } from '../../cli/src/cli.js';
import { buildTools } from '../../mcp-server/src/mcp-server.js';
import { AgentBrowserClient } from '../../sdk-typescript/src/client.js';
import { buildServer } from './server.js';

afterEach(() => vi.restoreAllMocks());

describe('capture requests through every consumption surface', () => {
  it('returns schema-valid observation and screenshot responses including inline artifacts', async () => {
    const server = await buildServer({ engine: new FakeEngine(), apiKeys: new Map() });
    try {
      const sessionId = (
        await server.inject({
          method: 'POST',
          url: '/v1/sessions',
          payload: { tenantId: 'parity' },
        })
      ).json().sessionId;
      const pageId = (
        await server.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/pages` })
      ).json().pageId;
      for (const [operation, schema] of [
        ['observe', PageStateSchema],
        ['screenshot', ArtifactRefSchema],
      ] as const) {
        const response = await server.inject({
          method: 'POST',
          url: `/v1/sessions/${sessionId}/pages/${pageId}/${operation}`,
          payload: {},
        });
        expect(response.statusCode).toBe(200);
        expect(new Ajv2020({ strict: false }).compile(schema)(response.json())).toBe(true);
      }
    } finally {
      await server.close();
    }
  });

  it('preserves engine-host warnings through REST, SDK, CLI, and MCP', async () => {
    const engine = new FakeEngine();
    const create = engine.createSession.bind(engine);
    vi.spyOn(engine, 'createSession').mockImplementation(async (options) =>
      Object.assign(await create(options), { warnings: ['Browser-host diagnostic'] })
    );
    const server = await buildServer({ engine, apiKeys: new Map() });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const response = await server.inject({
        method: 'POST',
        url: new URL(String(url)).pathname,
        headers: { 'content-type': 'application/json' },
        payload: init?.body as string,
      });
      return new Response(response.body, { status: response.statusCode });
    };
    try {
      const client = new AgentBrowserClient({ baseUrl: 'http://injected.test' });
      const created = await client.sessions.create({ tenantId: 'parity' });
      expect(created.warnings).toEqual(['Browser-host diagnostic']);
      const tool = buildTools(client).find((tool) => tool.name === 'browser_create');
      expect(await tool?.handler({ tenantId: 'parity' })).toMatchObject({
        warnings: ['Browser-host diagnostic'],
      });
      const out: string[] = [];
      const cli = buildCli({
        createClient: () => client,
        out: (line) => out.push(line),
        err: () => {},
      });
      expect(await cli.run(['session', 'create', '--tenant', 'parity'])).toBe(0);
      expect(out.join('\n')).toContain('Warning: Browser-host diagnostic');
    } finally {
      globalThis.fetch = originalFetch;
      await server.close();
    }
  });

  it.each(['api', 'sdk', 'cli', 'mcp'] as const)(
    '%s honors both pre-capture waits and rejects invalid requests',
    async (surface) => {
      const server = await buildServer({ engine: new FakeEngine(), apiKeys: new Map() });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const response = await server.inject({
          method: 'POST',
          url: new URL(String(url)).pathname,
          headers: { 'content-type': 'application/json' },
          payload: init?.body as string,
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: { 'content-type': 'application/json' },
        });
      };
      try {
        const sessionId = (
          await server.inject({
            method: 'POST',
            url: '/v1/sessions',
            payload: { tenantId: 'parity' },
          })
        ).json().sessionId;
        const pageId = (
          await server.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/pages` })
        ).json().pageId;
        const client = new AgentBrowserClient({ baseUrl: 'http://injected.test' });
        const tools = buildTools(client);
        for (const operation of ['observe', 'screenshot'] as const) {
          // Impossible condition proves the wait survives every transport before capture.
          const wait = { until: 'minElements' as const, count: 99, timeoutMs: 1 };
          if (surface === 'api') {
            const response = await server.inject({
              method: 'POST',
              url: `/v1/sessions/${sessionId}/pages/${pageId}/${operation}`,
              payload: { wait },
            });
            expect(response.statusCode).toBe(504);
            expect(response.json().error.code).toBe('ACTION_TIMEOUT');
            const invalid = await server.inject({
              method: 'POST',
              url: `/v1/sessions/${sessionId}/pages/${pageId}/${operation}`,
              payload: { wait: null },
            });
            expect(invalid.statusCode).toBe(400);
            expect(invalid.json().error.code).toBe('INVALID_REQUEST');
          } else if (surface === 'sdk') {
            await expect(
              client.sessions[operation](sessionId, pageId, { wait })
            ).rejects.toMatchObject({ code: 'ACTION_TIMEOUT' });
            await expect(
              client.sessions[operation](sessionId, pageId, { wait: null } as never)
            ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
          } else if (surface === 'mcp') {
            const tool = tools.find((tool) => tool.name === `browser_${operation}`);
            await expect(tool?.handler({ sessionId, pageId, wait })).rejects.toMatchObject({
              code: 'ACTION_TIMEOUT',
            });
            await expect(tool?.handler({ sessionId, pageId, wait: null })).rejects.toThrow(
              /Invalid capture request/
            );
          } else {
            const errors: string[] = [];
            const cli = buildCli({
              createClient: () => client,
              out: () => {},
              err: (line) => errors.push(line),
            });
            expect(
              await cli.run([
                operation,
                sessionId,
                pageId,
                '--wait-until',
                'minElements',
                '--wait-count',
                '99',
                '--wait-timeout',
                '1',
              ])
            ).toBe(1);
            expect(errors.join('\n')).toContain('ACTION_TIMEOUT');
            errors.length = 0;
            expect(
              await cli.run([
                operation,
                sessionId,
                pageId,
                '--wait-until',
                'minElements',
                '--wait-count',
                '1.5',
              ])
            ).toBe(1);
            expect(errors.join('\n')).toContain('--wait-count must be an integer');
          }
        }
      } finally {
        globalThis.fetch = originalFetch;
        await server.close();
      }
    }
  );
});
