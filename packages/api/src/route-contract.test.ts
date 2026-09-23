/**
 * Route-contract snapshot (capability-at-registration).
 *
 * EXPECTED is transcribed from the delegated capability matrix that governed
 * these routes before capability moved into registration metadata - it is an
 * independent oracle: if a refactor of the registration plumbing shifts any
 * route's delegated behavior, this table fails. `null` capability means the
 * route is not reachable by delegated grants at all (operators only), exactly
 * as the former regex table produced.
 */

import type { AgentCapability } from '@agentbrowser/protocol';
import { SELF_ADMITTING_ROUTE_SEGMENTS, agentModeAllows } from '@agentbrowser/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

const EXPECTED: Array<['GET' | 'POST' | 'PUT' | 'DELETE', string, AgentCapability | null]> = [
  ['GET', '/v1/sessions/:sessionId/approvals/:tokenId', null],
  ['POST', '/v1/sessions/:sessionId/approvals/:tokenId', null],
  ['POST', '/v1/sessions/:sessionId/application/execute', 'application.execute'],
  ['POST', '/v1/sessions/:sessionId/application/reviews', null],
  ['GET', '/v1/sessions/:sessionId/application/receipts/:operationId', 'application.discover'],
  ['DELETE', '/v1/sessions/:sessionId/application', null],
  ['GET', '/v1/sessions/:sessionId/application', 'application.discover'],
  ['PUT', '/v1/sessions/:sessionId/application', null],
  ['GET', '/v1/sessions/:sessionId/artifacts/:artifactId', 'page.capture'],
  ['POST', '/v1/sessions/:sessionId/control/delegate', null],
  ['POST', '/v1/sessions/:sessionId/control/prepare-resume', null],
  ['POST', '/v1/sessions/:sessionId/control/takeover', null],
  ['GET', '/v1/sessions/:sessionId/control', 'session.control'],
  ['GET', '/v1/sessions/:sessionId/cookies', null],
  ['GET', '/v1/sessions/:sessionId/events/replay', null],
  ['GET', '/v1/sessions/:sessionId/events', null],
  ['GET', '/v1/sessions/:sessionId/operations/:operationId', 'session.control'],
  ['POST', '/v1/sessions/:sessionId/pages/:pageId/act', 'page.interact'],
  ['POST', '/v1/sessions/:sessionId/pages/:pageId/autofill', 'page.form'],
  ['POST', '/v1/sessions/:sessionId/pages/:pageId/download', null],
  ['POST', '/v1/sessions/:sessionId/pages/:pageId/downloads/:filename', null],
  ['POST', '/v1/sessions/:sessionId/pages/:pageId/extract', 'page.extract'],
  ['POST', '/v1/sessions/:sessionId/pages/:pageId/html', 'page.capture'],
  ['POST', '/v1/sessions/:sessionId/pages/:pageId/navigate', 'page.navigate'],
  ['POST', '/v1/sessions/:sessionId/pages/:pageId/observe', 'page.observe'],
  ['POST', '/v1/sessions/:sessionId/pages/:pageId/outcomes', 'page.interact'],
  ['POST', '/v1/sessions/:sessionId/pages/:pageId/pdf', 'page.capture'],
  ['POST', '/v1/sessions/:sessionId/pages/:pageId/plan', 'page.interact'],
  ['POST', '/v1/sessions/:sessionId/pages/:pageId/screenshot', 'page.capture'],
  ['GET', '/v1/sessions/:sessionId/pages/:pageId/snapshot', 'page.observe'],
  ['DELETE', '/v1/sessions/:sessionId/pages/:pageId', 'session.manage'],
  ['GET', '/v1/sessions/:sessionId/pages/:pageId', 'page.observe'],
  ['GET', '/v1/sessions/:sessionId/pages', 'page.observe'],
  ['POST', '/v1/sessions/:sessionId/pages', 'session.manage'],
  ['POST', '/v1/sessions/:sessionId/trace', null],
  ['DELETE', '/v1/sessions/:sessionId', null],
  ['GET', '/v1/sessions/:sessionId', 'session.control'],
];

/** Observation-class POSTs: admitted but never dispatched, no operation identity. */
const SAFE_POSTS = new Set([
  '/v1/sessions/:sessionId/pages/:pageId/observe',
  '/v1/sessions/:sessionId/pages/:pageId/extract',
  '/v1/sessions/:sessionId/pages/:pageId/screenshot',
  '/v1/sessions/:sessionId/pages/:pageId/pdf',
  '/v1/sessions/:sessionId/pages/:pageId/html',
]);

/** The one self-admitting route outside the segment families. */
const DELETE_SESSION = '/v1/sessions/:sessionId';

describe('route contract metadata', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildServer();
  });

  afterAll(async () => {
    await server.close();
  });

  const sessionRoutes = () =>
    server.registeredRoutes.filter((route) => route.url.startsWith('/v1/sessions/:sessionId'));

  it('registers exactly the expected session-scoped routes', () => {
    const actual = sessionRoutes()
      .map((route) => `${route.method} ${route.url}`)
      .sort();
    const expected = EXPECTED.map(([method, url]) => `${method} ${url}`).sort();
    expect(actual).toEqual(expected);
  });

  it('declares the transcribed delegated capability on every route', () => {
    for (const [method, url, capability] of EXPECTED) {
      const route = sessionRoutes().find((r) => r.method === method && r.url === url);
      expect(route, `${method} ${url}`).toBeDefined();
      expect(route?.capability ?? null, `${method} ${url}`).toBe(capability);
    }
  });

  it('exposes capabilities the mode registry can actually grant', () => {
    for (const route of sessionRoutes()) {
      if (route.capability !== undefined && route.capability !== null) {
        expect(agentModeAllows('application', route.capability as AgentCapability)).toBe(
          route.capability.startsWith('application.') || route.capability === 'session.control'
        );
      }
    }
  });

  it('marks self admission exactly for the self-admitting families', () => {
    // Structurally: a self-admitting route must contain a self-admitting
    // segment or be the DELETE-session exception. The route wrapper's
    // behavior is covered by the HTTP suites (application-http, control
    // flows); this pins the declared shape against silent widening.
    const SELF_ADMITTED = new Set([
      'GET /v1/sessions/:sessionId/control',
      'POST /v1/sessions/:sessionId/control/takeover',
      'POST /v1/sessions/:sessionId/control/prepare-resume',
      'POST /v1/sessions/:sessionId/control/delegate',
      'GET /v1/sessions/:sessionId/operations/:operationId',
      'PUT /v1/sessions/:sessionId/application',
      'DELETE /v1/sessions/:sessionId/application',
      'GET /v1/sessions/:sessionId/application',
      'POST /v1/sessions/:sessionId/application/execute',
      'POST /v1/sessions/:sessionId/application/reviews',
      'GET /v1/sessions/:sessionId/application/receipts/:operationId',
      `DELETE ${DELETE_SESSION}`,
    ]);
    for (const key of SELF_ADMITTED) {
      const [method, url] = key.split(' ') as ['GET' | 'POST' | 'PUT' | 'DELETE', string];
      const isSelf =
        SELF_ADMITTING_ROUTE_SEGMENTS.some((segment) => url.includes(segment)) ||
        (method === 'DELETE' && url === DELETE_SESSION);
      expect(isSelf, key).toBe(true);
    }
    // And every OTHER route is envelope-admitted: no non-self route may
    // contain a self-admitting segment (a future route placed under one of
    // those families would silently skip the mutation envelope).
    for (const route of sessionRoutes()) {
      const key = `${route.method} ${route.url}`;
      if (SELF_ADMITTED.has(key)) continue;
      const containsSegment = SELF_ADMITTING_ROUTE_SEGMENTS.some((segment) =>
        route.url.includes(segment)
      );
      const isDeleteSession = route.method === 'DELETE' && route.url === DELETE_SESSION;
      expect(containsSegment || isDeleteSession, key).toBe(false);
    }
  });

  it('requires operation identity on every mutating envelope route', () => {
    for (const [method, url, capability] of EXPECTED) {
      if (capability === null && url === DELETE_SESSION) continue;
      const selfAdmitting =
        SELF_ADMITTING_ROUTE_SEGMENTS.some((segment) => url.includes(segment)) ||
        (method === 'DELETE' && url === DELETE_SESSION);
      if (selfAdmitting) continue;
      const mutating = method === 'DELETE' || (method === 'POST' && !SAFE_POSTS.has(url));
      if (mutating) {
        // The SDK mints an operation-id header for exactly these routes;
        // server and client must stay in lockstep (SELF_ADMITTING_ROUTE_
        // SEGMENTS is the shared constant both consume).
        expect(
          SELF_ADMITTING_ROUTE_SEGMENTS.some((segment) => url.includes(segment)),
          `${method} ${url}`
        ).toBe(false);
      }
    }
  });
});

describe('auto-generated HEAD duplicates follow GET capability', () => {
  // Fastify copies route config onto auto-generated HEAD duplicates, so a
  // delegated agent's HEAD is gated exactly like the GET it mirrors. (The
  // old regex table was method-keyed and 403'd every HEAD; that was an
  // accident of matching, not a boundary.) Pinned so the behavior stays a
  // decision, not a surprise.
  let server: FastifyInstance;
  let sessionPath: string;
  let token: string;

  beforeAll(async () => {
    server = await buildServer({
      apiKeys: new Map([
        [
          (await import('node:crypto')).createHash('sha256').update('operator').digest('hex'),
          'owner',
        ],
      ]),
    });
    const operatorHeaders = { authorization: 'Bearer operator' };
    const create = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: operatorHeaders,
      payload: { controlMode: 'delegated' },
    });
    sessionPath = `/v1/sessions/${create.json().sessionId}`;
    const review = await server.inject({
      method: 'POST',
      url: `${sessionPath}/control/prepare-resume`,
      headers: operatorHeaders,
    });
    const grant = await server.inject({
      method: 'POST',
      url: `${sessionPath}/control/delegate`,
      headers: operatorHeaders,
      payload: { epoch: review.json().epoch, mode: 'audit' },
    });
    token = grant.json().token as string;
  });

  afterAll(async () => {
    await server.close();
  });

  it('HEAD carries the GET capability: allowed where GET is allowed', async () => {
    const head = await server.inject({
      method: 'HEAD',
      url: `${sessionPath}/pages`,
      headers: { authorization: `Bearer ${token}` },
    });
    // audit carries page.observe; past the capability gate (downstream
    // statuses differ, but never a capability 403).
    expect(head.statusCode).not.toBe(403);
  });

  it('HEAD stays 403 where GET has no delegated capability', async () => {
    const head = await server.inject({
      method: 'HEAD',
      url: `${sessionPath}/cookies`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(head.statusCode).toBe(403);
  });
});

describe('delegated capability spot checks', () => {
  let server: FastifyInstance;
  let sessionPath: string;
  let token: string;

  beforeAll(async () => {
    server = await buildServer({
      // Delegated sessions require an authenticated operator; in local
      // no-keys mode they cannot be created at all.
      apiKeys: new Map([
        [
          (await import('node:crypto')).createHash('sha256').update('operator').digest('hex'),
          'owner',
        ],
      ]),
    });
    const operatorHeaders = { authorization: 'Bearer operator' };
    const create = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: operatorHeaders,
      payload: { controlMode: 'delegated' },
    });
    sessionPath = `/v1/sessions/${create.json().sessionId}`;
    const review = await server.inject({
      method: 'POST',
      url: `${sessionPath}/control/prepare-resume`,
      headers: operatorHeaders,
    });
    const grant = await server.inject({
      method: 'POST',
      url: `${sessionPath}/control/delegate`,
      headers: operatorHeaders,
      payload: { epoch: review.json().epoch, mode: 'audit' },
    });
    token = grant.json().token as string;
  });

  afterAll(async () => {
    await server.close();
  });

  it('denies a capability the mode does not carry (audit: page.form)', async () => {
    const denied = await server.inject({
      method: 'POST',
      url: `${sessionPath}/pages/pg_x/autofill`,
      headers: { authorization: `Bearer ${token}` },
      payload: { fields: [] },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');
  });

  it('admits a capability the mode carries without becoming an allowance (audit: page.observe)', async () => {
    const admitted = await server.inject({
      method: 'POST',
      url: `${sessionPath}/pages/pg_missing/observe`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    // Past the capability gate; the service refuses the missing page.
    expect(admitted.statusCode).not.toBe(403);
    expect(admitted.statusCode).toBe(404);
  });
});
