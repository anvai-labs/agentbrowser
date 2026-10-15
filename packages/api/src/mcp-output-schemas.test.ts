/**
 * T0 M2: every MCP tool with a structured result advertises an outputSchema, and the REAL result
 * — MCP handler -> SDK -> REST -> service on FakeEngine — validates against it. MCP clients reject
 * structuredContent that does not match the advertised schema, so a schema stricter than the
 * live shape would break agents; this test is the guard in both directions.
 */
import { FakeEngine } from '@agentbrowser/testkit';
import Ajv2020 from 'ajv/dist/2020';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTools } from '../../mcp-server/src/mcp-server.js';
import { AgentBrowserClient } from '../../sdk-typescript/src/client.js';
import { buildServer } from './server.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
type Tool = ReturnType<typeof buildTools>[number];

let server: Server;
let tools: Map<string, Tool>;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  server = await buildServer({ engine: new FakeEngine(), apiKeys: new Map() });
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

    const listed = await callValidated('pages', { sessionId });
    expect((listed.pages as unknown[]).length).toBeGreaterThanOrEqual(3);

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
