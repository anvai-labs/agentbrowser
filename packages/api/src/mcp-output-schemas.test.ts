/**
 * T0 M2: every MCP tool with a structured result advertises an outputSchema, and the REAL result
 * — MCP handler -> SDK -> REST -> service on FakeEngine — validates against it. MCP clients reject
 * structuredContent that does not match the advertised schema, so a schema stricter than the
 * live shape would break agents; this test is the guard in both directions.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationRecordResultSchema } from '@agentbrowser/protocol';
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
  globalThis.fetch = routeTo(server);
  const client = new AgentBrowserClient({ baseUrl: 'http://injected.test' });
  tools = new Map(buildTools(client).map((tool) => [tool.name, tool]));
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await server.close();
});

/** Route the SDK's fetch to an in-process server: method, path+query, headers and body intact. */
function routeTo(target: Server): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const response = await target.inject({
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
}

const callValidated = (name: string, args: Record<string, unknown>) => validated(tools, name, args);

/** Call a tool the way the MCP server does and validate its result against the advertised schema. */
async function validated(
  toolset: Map<string, Tool>,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const tool = toolset.get(name);
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

    const pdf = await callValidated('pdf', { sessionId, pageId });
    await callValidated('artifact', { sessionId, artifactId: pdf.artifactId });
    await callValidated('artifact', {
      sessionId,
      artifactId: pdf.artifactId,
      inline: true,
      maxBytes: 7,
    });

    await callValidated('events_replay', { sessionId });
    await callValidated('events_replay', { sessionId, type: 'console.log', since: -1, limit: 5 });

    const closed = await callValidated('close', { sessionId });
    expect(closed).toEqual({ sessionId, closed: true });
  });

  it('policy, cookies, snapshot, html, session and cookie_handoff', async () => {
    await callValidated('policy', {});
    await callValidated('policy', { action: 'request', target: 'https://example.com/' });

    const created = await callValidated('create', { tenantId: 'schemas-2' });
    const sessionId = created.sessionId as string;
    const pageId = created.pageId as string;
    await tools.get('navigate')?.handler({ sessionId, pageId, url: 'https://example.com/' });

    const cookies = await callValidated('cookies', { sessionId });
    expect(Array.isArray(cookies.cookies)).toBe(true);

    await callValidated('snapshot', { sessionId, pageId });
    await callValidated('snapshot', { sessionId, pageId, controls: true });

    const html = await callValidated('html', { sessionId, pageId });
    expect(html.untrustedContent).toBe(true);
    await callValidated('html', { sessionId, pageId, maxBytes: 7 });

    const inspected = await callValidated('session', { sessionId });
    expect(inspected.sessionId).toBe(sessionId);

    await callValidated('close', { sessionId });
  });

  it('cookie_handoff (relay, then completion) and a handed-off session, against the real server', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-schemas-'));
    const operatorKey = 'operator-key-schemas-01';
    const apiKey = 'api-key-schemas-aaaaaaaa';
    const keysFile = join(dir, 'operator.keys');
    await writeFile(keysFile, `${operatorKey}:owner\n`, 'utf8');
    const saved = {
      operator: process.env.AGENTBROWSER_OPERATOR_KEYS_FILE,
      api: process.env.AGENTBROWSER_API_KEYS,
    };
    process.env.AGENTBROWSER_OPERATOR_KEYS_FILE = keysFile;
    process.env.AGENTBROWSER_API_KEYS = `${apiKey}:owner`;
    const login: NonNullable<Parameters<typeof buildServer>[0]['loginBrowserPort']> = {
      isEnabled: true,
      isOpen: true,
      read: async () => ({
        cookies: [
          {
            name: 'session',
            value: 'operator-secret-value',
            domain: 'example.com',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
        skipped: { partitioned: 0, expired: 0 },
      }),
    };
    const handoffServer = await buildServer({ engine: new FakeEngine(), loginBrowserPort: login });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = routeTo(handoffServer);
    try {
      const client = new AgentBrowserClient({ baseUrl: 'http://injected.test', apiKey });
      const handoffTools = new Map(buildTools(client).map((tool) => [tool.name, tool]));
      const created = await client.sessions.create({
        tenantId: 'owner',
        policy: { allowedHosts: ['example.com'] },
      } as never);
      const sessionId = created.sessionId;

      const relay = await validated(handoffTools, 'cookie_handoff', {
        sessionId,
        domains: ['example.com'],
      });
      expect(relay).toMatchObject({ approvalRequired: true, sessionId });
      expect(JSON.stringify(relay)).not.toContain('operator-secret-value');

      const decided = await handoffServer.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/approvals/${relay.tokenId as string}`,
        headers: { authorization: `Bearer ${operatorKey}` },
        payload: {
          decision: 'approve',
          lease: { hosts: ['example.com'], expiresInMs: 60_000, maxActions: 5 },
        },
      });
      expect(decided.statusCode).toBe(200);

      const done = await validated(handoffTools, 'cookie_handoff', {
        sessionId,
        domains: ['example.com'],
        approvalToken: relay.tokenId,
      });
      expect(done).toMatchObject({ credentialSource: 'operator', sessionId });
      expect(JSON.stringify(done)).not.toContain('operator-secret-value');

      // The handed-off session's view carries credentialSource and the action lease.
      const inspected = await validated(handoffTools, 'session', { sessionId });
      expect(inspected.session).toMatchObject({ credentialSource: 'operator' });
    } finally {
      globalThis.fetch = previousFetch;
      await handoffServer.close();
      process.env.AGENTBROWSER_OPERATOR_KEYS_FILE = saved.operator;
      process.env.AGENTBROWSER_API_KEYS = saved.api;
      if (saved.operator === undefined) delete process.env.AGENTBROWSER_OPERATOR_KEYS_FILE;
      if (saved.api === undefined) delete process.env.AGENTBROWSER_API_KEYS;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the new schemas carry stable $ids', () => {
    // pdf shares screenshot's canonical artifact schema (no $id; it is an OpenAPI component).
    expect(tools.get('pdf')?.outputSchema).toBe(tools.get('screenshot')?.outputSchema);
    const ids = Object.fromEntries(
      [
        'create',
        'page_create',
        'pages',
        'close',
        'events_replay',
        'policy',
        'cookies',
        'cookie_handoff',
        'snapshot',
        'html',
        'session',
      ].map((name) => [name, (tools.get(name)?.outputSchema as { $id?: string } | undefined)?.$id])
    );
    expect(ids).toEqual({
      create: 'urn:agentbrowser:session-created:v1',
      page_create: 'urn:agentbrowser:page:v1',
      pages: 'urn:agentbrowser:page-list:v1',
      close: 'urn:agentbrowser:session-closed:v1',
      events_replay: 'urn:agentbrowser:session-events-page:v1',
      policy: 'urn:agentbrowser:policy-answer:v1',
      cookies: 'urn:agentbrowser:cookie-list:v1',
      cookie_handoff: 'urn:agentbrowser:cookie-handoff:v1',
      snapshot: 'urn:agentbrowser:page-snapshot:v1',
      html: 'urn:agentbrowser:page-html:v1',
      session: 'urn:agentbrowser:session-inspection:v1',
    });
  });

  it('the schemas are not vacuous: an empty object fails each one', () => {
    for (const [name, tool] of tools) {
      if (tool.outputSchema === undefined) continue;
      const validate = new Ajv2020({ strict: false }).compile(
        tools.get(name)?.outputSchema as object
      );
      expect(validate({}), `${name} accepted {}`).toBe(false);
    }
  });

  it('every tool advertises an outputSchema with an object root (the MCP tool contract)', () => {
    const missing: string[] = [];
    for (const [name, tool] of tools) {
      if (tool.outputSchema === undefined) missing.push(name);
      else expect((tool.outputSchema as { type?: string }).type, name).toBe('object');
    }
    // A new tool without a schema must be a deliberate, reviewed decision.
    expect(missing).toEqual([]);
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
    await call('policy', {});
    await call('policy', { action: 'request', target: 'example.com' });
    await call('navigate', { sessionId, pageId, url: 'https://example.com/' });
    await call('cookies', { sessionId });
    await call('snapshot', { sessionId, pageId, controls: true });
    await call('html', { sessionId, pageId, maxBytes: 9 });
    await call('session', { sessionId });
    // Error paths of the new schema'd tools still validate (the advertised error envelope).
    for (const [name, args] of [
      ['snapshot', { sessionId, pageId: 'pg_missing' }],
      ['html', { sessionId, pageId: 'pg_missing' }],
      ['cookie_handoff', { sessionId, domains: ['example.com'] }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, `${name} should be an error`).toBe(true);
    }

    // Error results: each must still be a readable isError result carrying the error envelope.
    for (const [name, args] of [
      ['pdf', { sessionId, pageId: 'pg_missing' }],
      ['navigate', { sessionId, pageId: 'pg_missing', url: 'https://example.com/' }],
      ['page_create', { sessionId, url: 'http://169.254.169.254/' }],
      ['create', { tenantId: 'client-view', engine: 'no-such-engine' }],
      // A thrown navigation failure: its envelope carries retryable and details as well.
      ['navigate', { sessionId, pageId, url: 'http://169.254.169.254/' }],
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

describe('schema contracts beyond the live fixtures (M2b review)', () => {
  const compile = (schema: unknown) => new Ajv2020({ strict: false }).compile(schema as object);
  const schemaOf = (name: string) => {
    const schema = tools.get(name)?.outputSchema;
    if (schema === undefined) throw new Error(`no schema for ${name}`);
    return schema;
  };

  it('a bound (delegated) MCP server advertises an object-rooted schema for every tool, operation included', async () => {
    const mcp = buildMcpServer({
      createClient: () => new AgentBrowserClient({ baseUrl: 'http://injected.test' }),
      sessionId: 'ses_bound',
    } as never);
    const send = async (id: number, method: string, params: unknown) =>
      JSON.parse(
        (await mcp.handle(JSON.stringify({ jsonrpc: '2.0', id, method, params }))) ?? 'null'
      );
    await send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const listed = (await send(2, 'tools/list', {})).result.tools as Array<{
      name: string;
      outputSchema?: { type?: string };
    }>;
    expect(listed.map((tool) => tool.name)).toContain('operation');
    expect(
      listed.filter((tool) => tool.outputSchema?.type !== 'object').map((t) => t.name)
    ).toEqual([]);
  });

  it('documented minimal shapes validate (optional fields really are optional)', () => {
    const cases: Array<[string, unknown]> = [
      ['policy', { policyVersion: 'v', summaryFor: 's', capabilities: { x: { allowed: true } } }],
      ['policy', { action: 'request', answers: [{ classSet: 'c', answer: { kind: 'invalid' } }] }],
      [
        'cookie_handoff',
        { sessionId: 's', credentialSource: 'operator', domains: ['a.example'], counts: {} },
      ],
      [
        'snapshot',
        {
          url: 'about:blank',
          title: '',
          revision: 0,
          mode: 'stable',
          fields: [],
          controls: [{ ref: 'e0_0', role: 'combobox', label: '' }],
        },
      ],
      [
        'cookies',
        {
          sessionId: 's',
          cookies: [
            {
              name: 'sid',
              value: 'v',
              domain: 'a.example',
              path: '/',
              expires: -1,
              sameSite: 'Lax',
              partitionKey: 'k',
            },
          ],
        },
      ],
      [
        'html',
        {
          sessionId: 's',
          pageId: 'p',
          artifactId: 'a',
          html: '',
          truncated: false,
          sizeBytes: 0,
          untrustedContent: true,
          warning: 'w',
        },
      ],
    ];
    for (const [name, instance] of cases) {
      const validate = compile(schemaOf(name));
      expect(validate(instance), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('every schema stays open: unknown fields at the top level are accepted', async () => {
    const created = await callValidated('create', { tenantId: 'openness' });
    const sessionId = created.sessionId as string;
    const pageId = created.pageId as string;
    for (const [name, args] of [
      ['snapshot', { sessionId, pageId }],
      ['html', { sessionId, pageId }],
      ['session', { sessionId }],
      ['cookies', { sessionId }],
      ['policy', {}],
    ] as const) {
      const result = await callValidated(name, args);
      const validate = compile(schemaOf(name));
      expect(validate({ ...result, futureField: { nested: true } }), name).toBe(true);
    }
    await callValidated('close', { sessionId });
  });

  it("a newer server's session and operation shapes still validate (relaxed nested objects and enums)", async () => {
    const created = await callValidated('create', { tenantId: 'forward' });
    const inspected = await callValidated('session', { sessionId: created.sessionId });
    const session = inspected.session as Record<string, unknown>;
    const newer = {
      ...inspected,
      session: {
        ...session,
        status: 'hibernating',
        lease: { ...(session.lease as object), futureLeaseField: 1 },
        closeCause: 'future_cause',
      },
    };
    expect(compile(schemaOf('session'))(newer)).toBe(true);
    await callValidated('close', { sessionId: created.sessionId });
    // The operation record schema: required fields kept (rejects {}), nested objects open.
    const operation = compile(OperationRecordResultSchema);
    expect(operation({})).toBe(false);
    expect(OperationRecordResultSchema.type).toBe('object');
    expect(JSON.stringify(OperationRecordResultSchema)).not.toContain(
      '"additionalProperties":false'
    );
  });
});
