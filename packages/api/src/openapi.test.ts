/**
 * TDD Tests for OpenAPI document generation (TD-026)
 *
 * The document is generated from the protocol's TypeBox schemas, which are
 * JSON Schema, so polyglot clients can be generated instead of hand-written.
 */

import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi';
import { buildServer } from './server';

type Json = Record<string, unknown>;

describe('OpenAPI document', () => {
  let doc: Json;

  beforeAll(() => {
    doc = buildOpenApiDocument() as Json;
  });

  describe('committed artifact', () => {
    it('is byte-fresh against the generator (pnpm --filter @agentbrowser/api openapi)', () => {
      // The committed root openapi.json is a generated catalog, not a
      // hand-maintained file (the MCP catalog digest gate, applied to REST).
      // A stale artifact means a generated client would disagree with the
      // served surface.
      const committed = readFileSync(new URL('../../../openapi.json', import.meta.url), 'utf8');
      expect(`${JSON.stringify(doc, null, 2)}\n`).toBe(committed);
    });
  });

  describe('envelope', () => {
    it('should be an OpenAPI 3.1 document', () => {
      expect(doc.openapi).toBe('3.1.0');
    });

    it('should carry service info', () => {
      expect(doc.info.title).toEqual(expect.any(String));
      expect(doc.info.version).toEqual(expect.any(String));
      expect(doc.info.description).toEqual(expect.any(String));
    });

    it('should declare a server', () => {
      expect(Array.isArray(doc.servers)).toBe(true);
      expect(doc.servers.length).toBeGreaterThan(0);
      expect(doc.servers[0].url).toEqual(expect.any(String));
    });
  });

  describe('paths', () => {
    it('should give every operation a unique operationId', () => {
      const ids: string[] = [];
      for (const item of Object.values(doc.paths) as Json[]) {
        for (const op of Object.values(item) as Json[]) {
          expect(op.operationId).toEqual(expect.any(String));
          ids.push(op.operationId);
        }
      }
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should give every operation a summary and a tag', () => {
      for (const item of Object.values(doc.paths) as Json[]) {
        for (const op of Object.values(item) as Json[]) {
          expect(op.summary).toEqual(expect.any(String));
          expect(op.tags?.length).toBeGreaterThan(0);
        }
      }
    });

    it('documents the closed delegated mode vocabulary and qa default', () => {
      const delegate = doc.paths['/v1/sessions/{sessionId}/control/delegate'].post;
      const mode = delegate.requestBody.content['application/json'].schema.properties.mode;
      expect(mode.default).toBe('qa');
      expect(mode.anyOf.map((entry: { const: string }) => entry.const)).toEqual([
        'qa',
        'operations',
        'audit',
        'appsec',
        'bounty',
        'forms',
        'application',
      ]);
      expect(JSON.stringify(doc.components.schemas.ControlGrant)).toContain('"mode"');
    });

    it('should declare every path template parameter', () => {
      for (const [path, item] of Object.entries(doc.paths) as [string, Json][]) {
        const templated = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        for (const op of Object.values(item) as Json[]) {
          const declared = (op.parameters ?? [])
            .filter((p: Json) => p.in === 'path')
            .map((p: Json) => p.name);
          for (const name of templated) {
            expect(declared).toContain(name);
          }
        }
      }
    });

    it('should mark every path parameter required', () => {
      for (const item of Object.values(doc.paths) as Json[]) {
        for (const op of Object.values(item) as Json[]) {
          for (const p of (op.parameters ?? []) as Json[]) {
            if (p.in === 'path') {
              expect(p.required).toBe(true);
            }
          }
        }
      }
    });
  });

  describe('responses', () => {
    it('should give every operation at least one success response', () => {
      for (const item of Object.values(doc.paths) as Json[]) {
        for (const op of Object.values(item) as Json[]) {
          const codes = Object.keys(op.responses ?? {});
          // 101 is the success status for WebSocket upgrade routes.
          expect(codes.some((c) => c.startsWith('2') || c === '101')).toBe(true);
        }
      }
    });

    it('should describe every response', () => {
      for (const item of Object.values(doc.paths) as Json[]) {
        for (const op of Object.values(item) as Json[]) {
          for (const response of Object.values(op.responses) as Json[]) {
            expect(response.description).toEqual(expect.any(String));
          }
        }
      }
    });

    it('should model every error response with the ApiError envelope', () => {
      for (const item of Object.values(doc.paths) as Json[]) {
        for (const op of Object.values(item) as Json[]) {
          for (const [code, response] of Object.entries(op.responses) as [string, Json][]) {
            if (code.startsWith('4') || code.startsWith('5')) {
              expect(response.content['application/json'].schema.$ref).toBe(
                '#/components/schemas/ApiError'
              );
            }
          }
        }
      }
    });

    it('should document 404 on every session- or page-scoped operation', () => {
      for (const [path, item] of Object.entries(doc.paths) as [string, Json][]) {
        if (!path.includes('{')) continue;
        for (const op of Object.values(item) as Json[]) {
          expect(Object.keys(op.responses)).toContain('404');
        }
      }
    });

    it('should document STALE_TARGET as a possible outcome of act', () => {
      const act = doc.paths['/v1/sessions/{sessionId}/pages/{pageId}/act'].post;
      expect(JSON.stringify(act)).toContain('STALE_TARGET');
    });
  });

  describe('components', () => {
    const expectedSchemas = [
      'ApiError',
      'ApiErrorDetail',
      'PageState',
      'PageElement',
      'PlanStep',
      'OutcomeRunRequest',
      'OutcomeRunReport',
      'OperationReplay',
      'ActionResult',
      'ObservationRequest',
      'ArtifactRef',
      'Viewport',
    ];

    it.each(expectedSchemas)('should expose the %s schema', (name) => {
      expect(doc.components.schemas[name]).toBeDefined();
    });

    it('documents /plan steps in the flat wire shape, not the nested ActionRequest', () => {
      const planStep = doc.components.schemas.PlanStep as Json;
      const actionConsts = JSON.stringify(planStep.properties.action);
      expect(actionConsts).toContain('"const":"click"');
      expect(JSON.stringify(planStep)).toContain('waitForLabel');
      expect(doc.components.schemas.ActionRequest).toBeUndefined();
      const planBody = JSON.stringify(
        doc.paths['/v1/sessions/{sessionId}/pages/{pageId}/plan'].post.requestBody
      );
      expect(planBody).toContain('#/components/schemas/PlanStep');
      expect(planBody).not.toContain('#/components/schemas/ActionRequest');
    });

    it('projects the canonical plan report including remap and per-step evidence', () => {
      const operation = doc.paths['/v1/sessions/{sessionId}/pages/{pageId}/plan'].post;
      expect(operation.responses['200'].content['application/json'].schema.$ref).toBe(
        '#/components/schemas/PlanReport'
      );
      const report = doc.components.schemas.PlanReport;
      expect(report.$id).toBe('urn:agentbrowser:plan-report:v1');
      expect(report.properties.results.items.properties.remap.properties.to.type).toBe('string');
      expect(report.properties.results.items.properties.result).toBeDefined();
    });

    it('projects the canonical outcome request and report without an aggregate pass flag', () => {
      const operation = doc.paths['/v1/sessions/{sessionId}/pages/{pageId}/outcomes'].post;
      expect(operation.requestBody.content['application/json'].schema.$ref).toBe(
        '#/components/schemas/OutcomeRunRequest'
      );
      expect(operation.responses['200'].content['application/json'].schema.oneOf).toEqual([
        { $ref: '#/components/schemas/OutcomeRunReport' },
        { $ref: '#/components/schemas/OperationReplay' },
      ]);
      const request = doc.components.schemas.OutcomeRunRequest;
      expect(request.properties.verification.properties.evidenceCorrelationId).toMatchObject({
        type: 'string',
        minLength: 1,
        maxLength: 128,
        pattern: '^[a-zA-Z0-9_-]{1,128}$',
      });
      expect(request.properties.verification.required).not.toContain('evidenceCorrelationId');
      expect(doc.components.schemas.OperationReplay.$id).toBe(
        'urn:agentbrowser:operation-replay:v1'
      );
      const report = doc.components.schemas.OutcomeRunReport;
      expect(report.$id).toBe('urn:agentbrowser:outcome-run-report:v1');
      expect(report.properties).toHaveProperty('plan');
      expect(report.properties).toHaveProperty('outcome');
      expect(report.properties).not.toHaveProperty('ok');
      expect(report.properties).not.toHaveProperty('pass');
    });

    it('should carry the protocol error taxonomy', () => {
      const codes = JSON.stringify(doc.components.schemas.ApiErrorDetail);
      for (const code of ['STALE_TARGET', 'TARGET_NOT_VISIBLE', 'TARGET_DISABLED', 'INTERNAL']) {
        expect(codes).toContain(code);
      }
    });

    it('should constrain element refs to the ref format', () => {
      expect(doc.components.schemas.PageElement.properties.ref.pattern).toBe('^e\\d+_\\d+$');
    });
  });

  describe('validity', () => {
    it('should resolve every internal $ref', () => {
      const refs = new Set<string>();
      const walk = (node: unknown) => {
        if (Array.isArray(node)) {
          node.forEach(walk);
        } else if (node && typeof node === 'object') {
          for (const [key, value] of Object.entries(node)) {
            if (key === '$ref' && typeof value === 'string') {
              refs.add(value);
            } else {
              walk(value);
            }
          }
        }
      };
      walk(doc);

      expect(refs.size).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(ref.startsWith('#/components/schemas/')).toBe(true);
        const name = ref.replace('#/components/schemas/', '');
        expect(doc.components.schemas[name]).toBeDefined();
      }
    });

    it('should compile every component schema as JSON Schema 2020-12', () => {
      const ajv = new Ajv2020({ strict: false, allErrors: true });

      for (const [name, schema] of Object.entries(doc.components.schemas)) {
        ajv.addSchema(schema as object, `#/components/schemas/${name}`);
      }

      for (const name of Object.keys(doc.components.schemas)) {
        expect(() => ajv.getSchema(`#/components/schemas/${name}`)).not.toThrow();
      }
    });

    it('should validate a real observation against the PageState schema', () => {
      const ajv = new Ajv2020({ strict: false });
      for (const [name, schema] of Object.entries(doc.components.schemas)) {
        ajv.addSchema(schema as object, `#/components/schemas/${name}`);
      }

      const validate = ajv.getSchema('#/components/schemas/PageState');
      expect(validate).toBeDefined();

      const valid = validate?.({
        sessionId: 'ses_1',
        pageId: 'pg_1',
        revision: 1,
        url: 'https://example.com',
        title: 'Example',
        status: 'interactive',
        elements: [{ ref: 'e1_0', role: 'button', name: 'Submit', visible: true, enabled: true }],
        truncated: false,
        untrustedContent: true,
      });

      expect(valid).toBe(true);
    });

    it('should reject an observation carrying a selector-shaped ref', () => {
      const ajv = new Ajv2020({ strict: false });
      for (const [name, schema] of Object.entries(doc.components.schemas)) {
        ajv.addSchema(schema as object, `#/components/schemas/${name}`);
      }

      const validate = ajv.getSchema('#/components/schemas/PageElement');
      const valid = validate?.({
        ref: 'button.submit',
        role: 'button',
        visible: true,
        enabled: true,
      });

      expect(valid).toBe(false);
    });
  });
});

describe('OpenAPI endpoint', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildServer();
  });

  it('should serve the document at /openapi.json', async () => {
    const response = await server.inject({ method: 'GET', url: '/openapi.json' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');

    const served = response.json();
    expect(served.openapi).toBe('3.1.0');
    expect(served.paths['/v1/sessions'].post).toBeDefined();
  });

  it('should serve a document exactly covering every registered route', async () => {
    const served = (await server.inject({ method: 'GET', url: '/openapi.json' })).json();

    // Bidirectional exact-set equality, from the server's own registration
    // records (see the onRoute collector in buildServer). This is the
    // stronger successor of the former leaf-substring spot check, which let
    // "implemented but never documented" routes pass CI - the exact failure
    // mode the old expectedPaths hand list once recorded in its own comment.
    const toOpenApiTemplate = (url: string) => url.replace(/:(\w+)/g, '{$1}');
    const registered = new Set(
      server.registeredRoutes
        // The operator panel is a human HTML page, deliberately not part of
        // the machine contract. OPTIONS is the CORS preflight catch-all.
        .filter((route) => route.url !== '/operator' && route.method !== 'OPTIONS')
        .map((route) => `${route.method} ${toOpenApiTemplate(route.url)}`)
    );
    const documented = new Set(
      Object.entries(served.paths as Json).flatMap(([path, item]) =>
        Object.keys(item as Json).map((method) => `${method.toUpperCase()} ${path}`)
      )
    );
    expect([...registered].sort()).toEqual([...documented].sort());
  });
});
