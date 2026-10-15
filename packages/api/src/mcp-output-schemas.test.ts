/**
 * T0 M2: every MCP tool with a structured result advertises an outputSchema, and the REAL result
 * — MCP handler -> SDK -> REST -> service on FakeEngine — validates against it. MCP clients reject
 * structuredContent that does not match the advertised schema, so a schema stricter than the
 * live shape would break agents; this test is the guard in both directions.
 */
import { FakeEngine } from '@agentbrowser/testkit';
import AjvDraft7 from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildMcpServer, buildTools } from '../../mcp-server/src/mcp-server.js';
import { AgentBrowserClient } from '../../sdk-typescript/src/client.js';
import { buildServer } from './server.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
type Tool = ReturnType<typeof buildTools>[number];

let server: Server;
let engine: FakeEngine;
let tools: Map<string, Tool>;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  engine = new FakeEngine();
  server = await buildServer({ engine, apiKeys: new Map() });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const response = await server.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(init?.body !== undefined && init.body !== null ? { payload: init.body as string } : {}),
    });
    return new Response(response.statusCode === 204 ? null : response.rawPayload, {
      status: response.statusCode,
      headers: { 'content-type': String(response.headers['content-type'] ?? 'application/json') },
    });
  };
  const client = new AgentBrowserClient({ baseUrl: 'http://injected.test' });
  tools = new Map(buildTools(client).map((tool) => [tool.name, tool]));
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await server.close();
});

/** Call a tool the way the MCP server does and validate its result against the advertised schema. */
async function callValidated(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`no ${name} tool`);
  expect(tool.outputSchema, `${name} advertises no outputSchema`).toBeDefined();
  const result = await tool.handler(args);
  // MCP: structuredContent is a JSON object.
  expect(typeof result === 'object' && result !== null && !Array.isArray(result)).toBe(true);
  const validate = new Ajv2020({ strict: false }).compile(tool.outputSchema as object);
  const valid = validate(JSON.parse(JSON.stringify(result)));
  expect(validate.errors ?? [], `${name} result does not match its outputSchema`).toEqual([]);
  expect(valid).toBe(true);
  return result as Record<string, unknown>;
}

describe('MCP output schemas validate real results (T0 M2)', () => {
  it('session and page lifecycle: create, page_create, pages, pdf, events_replay, close', async () => {
    const created = await callValidated('create', { tenantId: 'schemas' });
    const sessionId = created.sessionId as string;
    expect(created.pageId).toEqual(expect.any(String));

    const page = await callValidated('page_create', { sessionId });
    const pageId = page.pageId as string;
    await callValidated('page_create', { sessionId, url: 'https://example.com/' });

    // An adopted popup carries openerPageId: the open page schema must accept it.
    await tools.get('navigate')?.handler({ sessionId, pageId, url: 'https://example.com/' });
    const engineSessionId = engine.getSessionIds().at(-1);
    await engine.getFakePage(engineSessionId as string, pageId)?.openPopup();
    const listed = await vi.waitFor(async () => {
      const value = await callValidated('pages', { sessionId });
      const pages = value.pages as Array<{ openerPageId?: string }>;
      if (!pages.some((entry) => entry.openerPageId === pageId))
        throw new Error('popup not adopted yet');
      return value;
    });
    expect((listed.pages as unknown[]).length).toBeGreaterThanOrEqual(4);

    await callValidated('pdf', { sessionId, pageId });

    await callValidated('events_replay', { sessionId });
    await callValidated('events_replay', { sessionId, type: 'console.log', since: -1, limit: 5 });

    const closed = await callValidated('close', { sessionId });
    expect(closed).toEqual({ sessionId, closed: true });
  });

  it('the new schemas carry stable $ids', () => {
    // pdf shares screenshot's canonical artifact schema (no $id; it is an OpenAPI component).
    expect(tools.get('pdf')?.outputSchema).toBe(tools.get('screenshot')?.outputSchema);
    const ids = Object.fromEntries(
      ['create', 'page_create', 'pages', 'close', 'events_replay'].map((name) => [
        name,
        (tools.get(name)?.outputSchema as { $id?: string } | undefined)?.$id,
      ])
    );
    expect(ids).toEqual({
      create: 'urn:agentbrowser:session-created:v1',
      page_create: 'urn:agentbrowser:page:v1',
      pages: 'urn:agentbrowser:page-list:v1',
      close: 'urn:agentbrowser:session-closed:v1',
      events_replay: 'urn:agentbrowser:session-events-page:v1',
    });
  });

  it('the schemas are not vacuous: an empty object fails each one', () => {
    for (const name of ['create', 'page_create', 'pages', 'close', 'pdf', 'events_replay']) {
      const validate = new Ajv2020({ strict: false }).compile(
        tools.get(name)?.outputSchema as object
      );
      expect(validate({}), `${name} accepted {}`).toBe(false);
    }
  });
});

/**
 * The client's view (what the official MCP TypeScript SDK does): read outputSchema from
 * tools/list on the structured protocol, then validate EVERY tools/call result that carries
 * structuredContent, errors included, with a draft-07 Ajv. A success-only schema fails here on
 * the first structured error.
 */
describe('advertised schemas accept every structured result a client receives, errors included', () => {
  it('success and error results through the JSON-RPC server validate against tools/list', async () => {
    const mcp = buildMcpServer({
      createClient: () => new AgentBrowserClient({ baseUrl: 'http://injected.test' }),
    } as never);
    let id = 0;
    const rpc = async (method: string, params: unknown) =>
      JSON.parse(
        (await mcp.handle(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }))) ?? 'null'
      );
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'schema-qualification', version: '1' },
    });
    const listed = (await rpc('tools/list', {})).result.tools as Array<{
      name: string;
      outputSchema?: object;
    }>;
    const validators = new Map(
      listed
        .filter((tool) => tool.outputSchema !== undefined)
        .map((tool) => [
          tool.name,
          new AjvDraft7({ strict: false }).compile(tool.outputSchema as object),
        ])
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await rpc('tools/call', { name, arguments: args })).result as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
      };
      const validate = validators.get(name);
      if (result.structuredContent !== undefined && validate !== undefined) {
        const ok = validate(result.structuredContent);
        expect(
          validate.errors ?? [],
          `${name}: structuredContent rejected by its advertised schema`
        ).toEqual([]);
        expect(ok).toBe(true);
      }
      return result;
    };

    const created = await call('create', { tenantId: 'client-view' });
    const sessionId = created.structuredContent?.sessionId as string;
    const pageId = created.structuredContent?.pageId as string;
    await call('page_create', { sessionId });
    await call('pages', { sessionId });
    await call('pdf', { sessionId, pageId });
    await call('events_replay', { sessionId });

    // Error results: each must still be a readable isError result carrying the error envelope.
    for (const [name, args] of [
      ['pdf', { sessionId, pageId: 'pg_missing' }],
      ['navigate', { sessionId, pageId: 'pg_missing', url: 'https://example.com/' }],
      ['page_create', { sessionId, url: 'http://169.254.169.254/' }],
      ['create', { tenantId: 'client-view', engine: 'no-such-engine' }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, `${name} should be an error`).toBe(true);
    }
    await call('close', { sessionId });
    for (const [name, args] of [
      ['close', { sessionId }],
      ['pages', { sessionId }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, `${name} after close should be an error`).toBe(true);
      expect(result.structuredContent?.error).toMatchObject({ code: expect.any(String) });
    }
  });
});
