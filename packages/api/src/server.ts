/**
 * AgentBrowser REST API Server
 *
 * Fastify-based REST API server providing session management, navigation,
 * observation, and action execution endpoints. Routes are a thin translation
 * layer over AgentBrowserService; the engine is injected, so tests run
 * against FakeEngine and production runs PlaywrightChromiumEngine.
 */

import { createHash } from 'node:crypto';
import { InMemoryTracer, MetricsRegistry, type SecretManager } from '@agentbrowser/core';
import type { StructuredLogger } from '@agentbrowser/core';
import type { BrowserEngine } from '@agentbrowser/engine';
import {
  DELIVERED_EXTRACT_FORMATS,
  ErrorCode,
  validatePlanStep,
  validateSessionRequest,
} from '@agentbrowser/protocol';
import type { SessionPolicy } from '@agentbrowser/protocol';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ArtifactAuthorizer } from './artifact-auth.js';
import { buildOpenApiDocument } from './openapi.js';
import {
  AgentBrowserService,
  type ServiceActRequest,
  ServiceError,
  type ServiceSessionRequest,
} from './service.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  corsOrigin?: string | string[];
  /** Browser engine backing the server. Production must inject a real one. */
  engine?: BrowserEngine;
  /**
   * TD-BROWSER-7 Phase 1/2: named auxiliary engines for per-session routing
   * (e.g. `safari` -> SafaridriverEngine). Unknown names fail loudly.
   */
  engines?: Record<string, BrowserEngine>;
  /** Download payload fetcher; injectable so tests never touch the network. */
  downloader?(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Metrics registry exposed at /metrics; defaults to a fresh registry. */
  metrics?: MetricsRegistry;
  /** Span tracer; defaults to a bounded in-memory tracer (exportable per session). */
  tracer?: InMemoryTracer;
  /** Secret registry used to scrub traces/observations; defaults to empty. */
  secretManager?: SecretManager;
  /** Structured operation log; when absent, no operation logging. */
  logger?: StructuredLogger;
  /** Session-default overrides plumbed to the coordinator (see ServiceDependencies). */
  defaultTtlMs?: number;
  defaultIdleTimeoutMs?: number;
  /**
   * Bearer-key authentication: SHA-256(key) -> tenantId. When absent (and no
   * AGENTBROWSER_API_KEYS env), auth is disabled with a loud warning -
   * the spec's trusted single-tenant local mode.
   */
  apiKeys?: Map<string, string>;
}

/** SHA-256 hex digest. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Parse AGENTBROWSER_API_KEYS ("key:tenant,key:tenant,...") into a
 * hash-keyed map; undefined when the variable is unset.
 */
function apiKeysFromEnv(): Map<string, string> | undefined {
  const raw = process.env.AGENTBROWSER_API_KEYS;
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const keys = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const separator = pair.lastIndexOf(':');
    if (separator <= 0) {
      continue;
    }
    const key = pair.slice(0, separator).trim();
    const tenant = pair.slice(separator + 1).trim();
    if (key.length > 0 && tenant.length > 0) {
      keys.set(sha256Hex(key), tenant);
    }
  }
  return keys;
}

/**
 * Map protocol error codes onto HTTP statuses (hygiene F3).
 *
 * Exhaustive over the ErrorCode enum: the `satisfies Record<ErrorCode,
 * number>` check makes this a compile error the moment a new code is added
 * without a mapping - the hand-maintained switch previously drifted to 6
 * unmapped members, three of them LIVE-thrown (ACTION_TIMEOUT with
 * retryable=true reached clients as an incoherent 500; ENGINE_CRASHED as
 * 500; INVALID_TENANT_ID wasn't even in the enum, violating the protocol
 * error schema).
 */
const STATUS_FOR = {
  // 400 family: the request was bad (bad shape, bad target, bad tenant).
  [ErrorCode.INVALID_REQUEST]: 400,
  [ErrorCode.INVALID_TENANT_ID]: 400,
  [ErrorCode.STALE_TARGET]: 400,
  [ErrorCode.TARGET_NOT_FOUND]: 400,
  [ErrorCode.TARGET_AMBIGUOUS]: 400,
  [ErrorCode.TARGET_NOT_VISIBLE]: 400,
  [ErrorCode.TARGET_DISABLED]: 400,
  [ErrorCode.OUTPUT_TRUNCATED]: 400,
  // Auth/permission.
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.POLICY_DENIED]: 403,
  [ErrorCode.APPROVAL_REQUIRED]: 403,
  [ErrorCode.DOWNLOAD_BLOCKED]: 403,
  // Gone.
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.SESSION_NOT_FOUND]: 404,
  [ErrorCode.PAGE_NOT_FOUND]: 404,
  [ErrorCode.SESSION_EXPIRED]: 410,
  // The service could not satisfy the request shape (engine can't do it).
  [ErrorCode.ENGINE_UNSUPPORTED]: 422,
  // Too much.
  [ErrorCode.QUOTA_EXCEEDED]: 429,
  // The browser side timed out waiting (retryable per the service).
  [ErrorCode.NAVIGATION_TIMEOUT]: 504,
  [ErrorCode.ACTION_TIMEOUT]: 504,
  // In-band today (plan envelope, HTTP 200); mapped in case it's ever
  // thrown as a ServiceError.
  [ErrorCode.PLAN_WAIT_TIMEOUT]: 504,
  // Server-side failures.
  [ErrorCode.ENGINE_CRASHED]: 500,
  [ErrorCode.INTERNAL]: 500,
} satisfies Record<ErrorCode, number>;

/** Map protocol error codes onto HTTP statuses. */
function statusFor(code: string): number {
  return STATUS_FOR[code as ErrorCode] ?? 500;
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: false, // Disable logging for cleaner test output
  });

  // Register CORS plugin
  await fastify.register(cors, {
    origin: options.corsOrigin || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    preflight: true,
  });

  // WebSocket event streaming (spec 13.1: session events).
  await fastify.register(websocket);

  // Security headers
  fastify.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '1; mode=block');
  });

  // The engine is normally injected (bin.ts passes PlaywrightChromiumEngine).
  // The in-memory engine is a development fallback, loaded lazily so
  // production deployments never need the testkit dev dependency.
  let engine = options.engine;
  if (!engine) {
    console.warn(
      '[agentbrowser] No engine injected; using the in-memory FakeEngine. ' +
        'Pass an engine to ServerOptions for real browsing.'
    );
    const { FakeEngine } = await import('@agentbrowser/testkit');
    engine = new FakeEngine();
  }
  const metrics = options.metrics ?? new MetricsRegistry();
  // Trace export (A3): without a tracer, the service emits no spans and
  // the export route would have nothing to serve. In-memory, bounded
  // (RingBuffer), secret-scrubbed via the service's secret manager.
  const tracer =
    options.tracer ??
    new InMemoryTracer({
      ...(options.secretManager ? { secretManager: options.secretManager } : {}),
    });
  const service = new AgentBrowserService({
    engine,
    ...(options.engines ? { engines: options.engines } : {}),
    metrics,
    tracer,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.downloader ? { downloader: options.downloader } : {}),
    ...(options.defaultTtlMs !== undefined ? { defaultTtlMs: options.defaultTtlMs } : {}),
    ...(options.defaultIdleTimeoutMs !== undefined
      ? { defaultIdleTimeoutMs: options.defaultIdleTimeoutMs }
      : {}),
  });

  fastify.addHook('onClose', async () => {
    await service.shutdown();
  });

  /** Translate a service failure into the protocol error envelope. */
  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ServiceError) {
      return reply.status(statusFor(error.code)).send({
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      });
    }
    return reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: error instanceof Error ? error.message : 'Unknown error',
        retryable: false,
      },
    });
  };

  const requireBody = (reply: FastifyReply, body: unknown): body is Record<string, unknown> => {
    if (body === undefined || body === null || typeof body !== 'object') {
      reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'A JSON request body is required',
          retryable: false,
        },
      });
      return false;
    }
    return true;
  };

  /**
   * Wrap a /v1 handler with the try/catch -> fail(reply, error) frame every
   * route below needed (hygiene F1). A pure mechanical extraction - no
   * handler body logic changes, only the duplicated shell is removed. Grew
   * to 22 identical copies (from 16 at the last audit) as new routes kept
   * repeating the pattern instead of using an abstraction.
   */
  const route =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        return fail(reply, error);
      }
    };

  /**
   * Extract typed path params without re-declaring the shape at each call
   * site (hygiene F2, grew to 21 copies). Fastify guarantees a matched
   * route's named segments are present strings, so this never defaults -
   * the `= ''` defaults two call sites previously carried were dead code
   * for exactly that reason.
   */
  const params = <K extends string>(request: FastifyRequest, ...keys: K[]): Record<K, string> => {
    const raw = request.params as Record<string, string>;
    return Object.fromEntries(keys.map((k) => [k, raw[k]])) as Record<K, string>;
  };

  fastify.get('/health/live', async (request, reply) => {
    return { status: 'live', timestamp: new Date().toISOString() };
  });

  const apiKeys = options.apiKeys ?? apiKeysFromEnv();
  if (apiKeys === undefined || apiKeys.size === 0) {
    console.warn(
      '[agentbrowser] No API keys configured; /v1 is UNAUTHENTICATED. ' +
        'Set AGENTBROWSER_API_KEYS=key:tenant[,key:tenant...] for multi-tenant use.'
    );
  }

  /** Bearer check for infra planes; undefined tenant when unauthenticated. */
  const infraTenantOf = (request: FastifyRequest): string | undefined => {
    if (apiKeys === undefined || apiKeys.size === 0) {
      return undefined; // no-keys local mode: everything open, loudly warned
    }
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    return token.length > 0 ? apiKeys.get(sha256Hex(token)) : undefined;
  };

  fastify.get('/health/ready', async (request, reply) => {
    try {
      // Unauthenticated probes get a minimal, disclosure-free answer.
      const tenant = infraTenantOf(request);
      if (tenant === undefined && apiKeys !== undefined && apiKeys.size > 0) {
        return {
          status: await engine.capabilities().then(
            () => 'ready',
            () => 'unavailable'
          ),
        };
      }
      const capabilities = await engine.capabilities();
      return { status: 'ready', engine: engine.name, version: engine.version, capabilities };
    } catch (error) {
      return reply.status(503).send({
        error: {
          code: 'ENGINE_CRASHED',
          message: `Engine is not responding: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
        },
      });
    }
  });

  // Metrics are operational data: authenticated when keys are configured.
  fastify.get('/metrics', async (request, reply) => {
    if (infraTenantOf(request) === undefined && apiKeys !== undefined && apiKeys.size > 0) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'A valid Authorization: Bearer <apiKey> header is required.',
          retryable: false,
        },
      });
    }
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render());
  });

  fastify.get('/health', async (request, reply) => {
    return {
      status: 'healthy',
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });

  const openApiDocument = buildOpenApiDocument();
  fastify.get('/openapi.json', async (_request, reply) => {
    return reply.type('application/json').send(openApiDocument);
  });

  // ------------------------------------------------------------------
  // /v1 resource routes: versioned per spec 13.1, authenticated when API
  // keys are configured. Infra planes (health/metrics/openapi) stay
  // unversioned and unauthenticated by design.
  // ------------------------------------------------------------------
  const artifactAuth = new ArtifactAuthorizer({
    key: process.env.AGENTBROWSER_ARTIFACT_KEY ?? 'dev-artifact-key',
  });

  await fastify.register(
    async (v1) => {
      if (apiKeys !== undefined && apiKeys.size > 0) {
        v1.addHook('onRequest', async (request, reply) => {
          const header = request.headers.authorization ?? '';
          const token = header.startsWith('Bearer ') ? header.slice(7) : '';
          const tenant = token.length > 0 ? apiKeys.get(sha256Hex(token)) : undefined;
          if (tenant === undefined) {
            return reply.status(401).send({
              error: {
                code: 'UNAUTHORIZED',
                message: 'A valid Authorization: Bearer <apiKey> header is required.',
                retryable: false,
              },
            });
          }
          (request as FastifyRequest & { tenant?: string }).tenant = tenant;
        });
      }

      const tenantOf = (request: FastifyRequest): string | undefined =>
        (request as FastifyRequest & { tenant?: string }).tenant;

      /** 403 unless the session belongs to the caller's tenant. */
      const requireOwnership = (
        reply: FastifyReply,
        sessionId: string,
        tenant: string | undefined
      ): boolean => {
        if (tenant === undefined) {
          return true; // unauthenticated local mode: no tenancy to enforce
        }
        const session = service.getSession(sessionId);
        if (session === undefined) {
          return true; // let the route's own 404 handle missing sessions
        }
        const owner = (session as { tenantId?: string }).tenantId;
        if (owner !== undefined && owner !== tenant) {
          reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: `Session ${sessionId} belongs to another tenant.`,
              retryable: false,
            },
          });
          return false;
        }
        return true;
      };

      // Session management endpoints
      v1.post(
        '/sessions',
        route(async (request, reply) => {
          const body = request.body;
          if (!requireBody(reply, body)) {
            return reply;
          }

          const authenticatedTenant = tenantOf(request);
          if (authenticatedTenant !== undefined) {
            // With keys configured, the key's tenant wins; a mismatching body
            // tenant is a cross-tenant attempt.
            const bodyTenant = (body as Record<string, unknown>).tenantId;
            if (bodyTenant !== undefined && bodyTenant !== authenticatedTenant) {
              return reply.status(403).send({
                error: {
                  code: 'FORBIDDEN',
                  message: `API key belongs to tenant ${authenticatedTenant}.`,
                  retryable: false,
                },
              });
            }
            (body as Record<string, unknown>).tenantId = authenticatedTenant;
          } else if (typeof (body as Record<string, unknown>).tenantId !== 'string') {
            return reply.status(400).send({
              error: { code: 'INVALID_REQUEST', message: 'tenantId is required', retryable: false },
            });
          }

          // ADR-015 B4: schema validation (compiled from the protocol's
          // SessionRequestSchema) replaces the hand-rolled checks; the
          // nested `policy` object maps onto the service's flat fields at
          // this boundary (flat fields keep working - validation passes
          // them through untouched, and explicit nested policy wins).
          const validated = validateSessionRequest(body);
          if (!validated.ok) {
            const details = validated.issues
              .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
              .join('; ');
            return reply.status(400).send({
              error: {
                code: 'INVALID_REQUEST',
                message: `Invalid session request: ${details}`,
                retryable: false,
              },
            });
          }
          const { cookies, ...validatedRequest } = validated.value;
          const policy = (body as { policy?: SessionPolicy }).policy;
          const createRequest: ServiceSessionRequest = { ...validatedRequest };
          // Structurally identical wire shapes; the protocol type's stricter
          // optionals (no | undefined) need explicit casts under
          // exactOptionalPropertyTypes - hence assignments, not spreads.
          if (cookies !== undefined) {
            createRequest.cookies = cookies as NonNullable<ServiceSessionRequest['cookies']>;
          }
          if (policy?.allowedHosts !== undefined) {
            createRequest.allowedHosts = policy.allowedHosts;
          }
          if (policy?.blockedHosts !== undefined) {
            createRequest.blockedHosts = policy.blockedHosts;
          }
          if (policy?.allowDownloads !== undefined) {
            createRequest.allowDownloads = policy.allowDownloads;
          }
          if (policy?.maxDownloadBytes !== undefined) {
            createRequest.maxDownloadBytes = policy.maxDownloadBytes;
          }
          const session = await service.createSession(createRequest as never);
          return reply.status(201).send(session);
        })
      );

      // Session event stream: WebSocket upgrade, JSON per frame.
      v1.get('/sessions/:sessionId/events', { websocket: true }, (socket, request) => {
        const { sessionId } = params(request, 'sessionId');
        const tenant = (request as FastifyRequest & { tenant?: string }).tenant;
        if (tenant !== undefined) {
          const session = service.getSession(sessionId);
          const owner = session && (session as { tenantId?: string }).tenantId;
          if (owner !== undefined && owner !== tenant) {
            socket.close(4403, 'forbidden');
            return;
          }
        }

        const unsubscribe = service.subscribe(sessionId, (event) => {
          socket.send(JSON.stringify(event));
        });
        if (unsubscribe === undefined) {
          socket.close(4404, 'session not found');
          return;
        }

        socket.on('close', () => {
          unsubscribe();
        });
        socket.on('error', () => {
          unsubscribe();
        });
      });

      v1.get(
        '/sessions',
        route(async (request, reply) => {
          return reply.send({ sessions: service.listSessions() });
        })
      );

      v1.get(
        '/sessions/:sessionId',
        route(async (request, reply) => {
          const { sessionId } = params(request, 'sessionId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          const session = service.getSession(sessionId);

          if (!session) {
            return reply.status(404).send({
              error: {
                code: 'SESSION_NOT_FOUND',
                message: `Session ${sessionId} not found`,
                retryable: false,
              },
            });
          }

          return reply.send(session);
        })
      );

      v1.get(
        '/sessions/:sessionId/cookies',
        route(async (request, reply) => {
          const { sessionId } = params(request, 'sessionId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          return reply.send({ cookies: await service.getSessionCookies(sessionId) });
        })
      );

      // A3 evidence: the session's recent event ledger (console replay).
      v1.get(
        '/sessions/:sessionId/events/replay',
        route(async (request, reply) => {
          const { sessionId } = params(request, 'sessionId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          // request.* events live in their own ledger (network summary,
          // spec 5.1); getSessionEvents routes the filter accordingly.
          const typeFilter = (request.query as { type?: string } | null)?.type;
          return reply.send({ events: service.getSessionEvents(sessionId, typeFilter) });
        })
      );

      // A3 evidence: export the session's completed spans as an artifact.
      v1.post(
        '/sessions/:sessionId/trace',
        route(async (request, reply) => {
          const { sessionId } = params(request, 'sessionId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          return reply.status(201).send(await service.exportTrace(sessionId));
        })
      );

      // A3 evidence: capture the page's current HTML as an artifact.
      v1.post(
        '/sessions/:sessionId/pages/:pageId/html',
        route(async (request, reply) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          return reply.status(201).send(await service.exportHtml(sessionId, pageId));
        })
      );

      v1.get(
        '/sessions/:sessionId/pages/:pageId/snapshot',
        route(async (request, reply) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          // Payload economics (TD-BROWSER-8 pressure matrix, row 4).
          const query = request.query as { maxElements?: string; maxBytes?: string };
          const maxElements =
            query.maxElements !== undefined ? Number.parseInt(query.maxElements, 10) : undefined;
          const maxBytes =
            query.maxBytes !== undefined ? Number.parseInt(query.maxBytes, 10) : undefined;
          return reply.send(
            await service.getSnapshot(sessionId, pageId, {
              ...(maxElements !== undefined ? { maxElements } : {}),
              ...(maxBytes !== undefined ? { maxBytes } : {}),
            })
          );
        })
      );

      v1.post(
        '/sessions/:sessionId/pages/:pageId/plan',
        route(async (request, reply) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          const body = request.body as { actions?: Array<Record<string, unknown>> };
          if (!Array.isArray(body.actions)) {
            return reply.status(400).send({
              error: {
                code: 'INVALID_REQUEST',
                message: 'body.actions must be an array of plan steps',
                retryable: false,
              },
            });
          }
          // Plan steps were the last unvalidated request surface (a bare
          // array cast): garbage waitForLabel/waitMs rode straight into
          // waitForLabel's deadline arithmetic (NaN deadline = a poll loop
          // that never exits). Each step is schema-checked on entry now;
          // the service-side clamp remains as defense in depth.
          for (const [index, step] of body.actions.entries()) {
            const validated = validatePlanStep(step);
            if (!validated.ok) {
              const details = validated.issues
                .map(
                  (issue: { path: string; message: string }) =>
                    `actions[${index}]${issue.path}: ${issue.message}`
                )
                .join('; ');
              return reply.status(400).send({
                error: {
                  code: 'INVALID_REQUEST',
                  message: `Invalid plan step: ${details}`,
                  retryable: false,
                },
              });
            }
          }
          return reply.send(
            await service.executePlan(
              sessionId,
              pageId,
              body.actions as unknown as ServiceActRequest[]
            )
          );
        })
      );

      v1.delete(
        '/sessions/:sessionId',
        route(async (request, reply) => {
          const { sessionId } = params(request, 'sessionId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          await service.closeSession(sessionId);
          return reply.send({ sessionId, status: 'closed' });
        })
      );

      // Page management endpoints
      v1.post(
        '/sessions/:sessionId/pages',
        route(async (request, reply) => {
          const { sessionId } = params(request, 'sessionId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          const page = await service.createPage(sessionId);
          return reply.status(201).send(page);
        })
      );

      v1.get(
        '/sessions/:sessionId/pages/:pageId',
        route(async (request, reply) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          const page = service.getPage(sessionId, pageId);

          if (!page) {
            return reply.status(404).send({
              error: {
                code: 'NOT_FOUND',
                message: `Page ${pageId} not found`,
                retryable: false,
              },
            });
          }

          return reply.send(page);
        })
      );

      v1.delete(
        '/sessions/:sessionId/pages/:pageId',
        route(async (request, reply) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          await service.closePage(sessionId, pageId);
          return reply.send({ pageId, status: 'closed' });
        })
      );

      // Navigation endpoint
      v1.post(
        '/sessions/:sessionId/pages/:pageId/navigate',
        route(async (request, reply) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          const body = request.body;
          if (!requireBody(reply, body)) {
            return reply;
          }

          const { url, waitUntil } = body as { url?: string; waitUntil?: string };

          if (typeof url !== 'string' || url.length === 0) {
            return reply.status(400).send({
              error: {
                code: 'INVALID_REQUEST',
                message: 'url is required and must be a string',
                retryable: false,
              },
            });
          }

          const result = await service.navigate(sessionId, pageId, {
            url,
            ...(waitUntil !== undefined
              ? { waitUntil: waitUntil as 'load' | 'domcontentloaded' | 'networkidle' }
              : {}),
          });
          return reply.send(result);
        })
      );

      // Observation endpoint
      v1.post(
        '/sessions/:sessionId/pages/:pageId/observe',
        route(async (request, reply) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          const observation = await service.observe(
            sessionId,
            pageId,
            (request.body ?? {}) as never
          );
          return reply.send(observation);
        })
      );

      // Action execution endpoint
      v1.post(
        '/sessions/:sessionId/pages/:pageId/act',
        route(async (request, reply) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          const body = request.body;
          if (!requireBody(reply, body)) {
            return reply;
          }

          const {
            action,
            target,
            value,
            key,
            direction,
            amount,
            observe,
            expectedRevision,
            approvalToken,
            promptText,
            wait,
            condition,
          } = body as Record<string, unknown>;

          if (typeof action !== 'string') {
            return reply.status(400).send({
              error: {
                code: 'INVALID_REQUEST',
                message: 'action is required and must be a string',
                retryable: false,
              },
            });
          }

          const result = await service.act(sessionId, pageId, {
            action,
            ...(target !== undefined ? { target: target as { ref: string } } : {}),
            ...(value !== undefined ? { value: value as string } : {}),
            ...(key !== undefined ? { key: key as string } : {}),
            ...(direction !== undefined
              ? { direction: direction as 'up' | 'down' | 'left' | 'right' }
              : {}),
            ...(amount !== undefined ? { amount: amount as number } : {}),
            ...(observe !== undefined ? { observe: observe as 'after' | 'none' } : {}),
            ...(expectedRevision !== undefined
              ? { expectedRevision: expectedRevision as number }
              : {}),
            ...(approvalToken !== undefined ? { approvalToken: approvalToken as string } : {}),
            ...(promptText !== undefined ? { promptText: promptText as string } : {}),
            ...(wait !== undefined ? { wait: wait as { until: string; timeoutMs?: number } } : {}),
            ...(condition !== undefined
              ? { condition: condition as { until: string; timeoutMs?: number } }
              : {}),
          });
          return reply.send(result);
        })
      );

      // Download endpoint: policy-gated artifact capture
      v1.post(
        '/sessions/:sessionId/pages/:pageId/download',
        route(async (request, reply) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          const body = request.body;
          if (!requireBody(reply, body)) {
            return reply;
          }

          const { url, filename } = body as { url?: string; filename?: string };
          if (typeof url !== 'string' || url.length === 0) {
            return reply.status(400).send({
              error: {
                code: 'INVALID_REQUEST',
                message: 'url is required and must be a string',
                retryable: false,
              },
            });
          }

          const artifact = await service.download(sessionId, pageId, {
            url,
            ...(filename !== undefined ? { filename } : {}),
          });
          return reply.send(artifact);
        })
      );

      // Artifact retrieval, scoped to the owning session
      v1.get(
        '/sessions/:sessionId/artifacts/:artifactId',
        route(async (request, reply) => {
          const { sessionId, artifactId } = params(request, 'sessionId', 'artifactId');
          // Access granted by session ownership OR a short-lived signed
          // token minted when the artifact was created (spec 13.1).
          const query = request.query as { token?: string };
          const tokenValid =
            query.token !== undefined && artifactAuth.verify(artifactId, query.token);
          if (!tokenValid && !requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          const stored = service.getArtifact(sessionId, artifactId);
          if (!stored) {
            return reply.status(404).send({
              error: {
                code: 'NOT_FOUND',
                message: `Artifact ${artifactId} not found`,
                retryable: false,
              },
            });
          }

          return reply.send({
            metadata: stored.metadata,
            contentBase64: Buffer.from(stored.bytes).toString('base64'),
          });
        })
      );

      // Collect an intercepted in-page download (spec 10)
      v1.post(
        '/sessions/:sessionId/pages/:pageId/downloads/:filename',
        route(async (request, reply) => {
          const { sessionId, pageId, filename } = params(
            request,
            'sessionId',
            'pageId',
            'filename'
          );
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }

          const artifact = await service.collectDownload(sessionId, pageId, filename);
          return reply.send(artifact);
        })
      );

      // PDF capture endpoint
      v1.post(
        '/sessions/:sessionId/pages/:pageId/pdf',
        route(async (request, reply) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          const body = (request.body ?? {}) as {
            landscape?: boolean;
            displayHeaderFooter?: boolean;
            printBackground?: boolean;
          };

          const artifact = await service.pdf(sessionId, pageId, {
            ...(body.landscape !== undefined ? { landscape: body.landscape } : {}),
            ...(body.displayHeaderFooter !== undefined
              ? { displayHeaderFooter: body.displayHeaderFooter }
              : {}),
            ...(body.printBackground !== undefined
              ? { printBackground: body.printBackground }
              : {}),
          });
          return reply.send(artifact);
        })
      );

      // Extraction endpoint (spec 12): deterministic extractors with evidence
      v1.post(
        '/sessions/:sessionId/pages/:pageId/extract',
        route(async (request, reply) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          const body = request.body;
          if (!requireBody(reply, body)) {
            return reply;
          }

          const format = (body as { format?: string }).format;
          const schema = (body as { schema?: Record<string, unknown> }).schema;
          const supported: readonly string[] = DELIVERED_EXTRACT_FORMATS;
          if (typeof format !== 'string' || !supported.includes(format)) {
            return reply.status(400).send({
              error: {
                code: 'INVALID_REQUEST',
                message: `Unknown format ${String(format)}. Supported: ${supported.join(', ')}`,
                retryable: false,
              },
            });
          }

          const result = await service.extract(sessionId, pageId, {
            format: format as never,
            ...(schema !== undefined ? { schema } : {}),
          });
          return reply.send(result);
        })
      );

      // Screenshot endpoint
      v1.post(
        '/sessions/:sessionId/pages/:pageId/screenshot',
        route(async (request, reply) => {
          const { sessionId, pageId } = params(request, 'sessionId', 'pageId');
          if (!requireOwnership(reply, sessionId, tenantOf(request))) {
            return reply;
          }
          const body = (request.body ?? {}) as {
            fullPage?: boolean;
            format?: string;
            quality?: number;
            maskSensitive?: boolean;
          };

          const format = body.format ?? 'png';
          const contentTypes: Record<string, string> = {
            png: 'image/png',
            jpeg: 'image/jpeg',
            webp: 'image/webp',
          };
          const contentType = contentTypes[format];

          if (!contentType) {
            return reply.status(400).send({
              error: {
                code: 'INVALID_REQUEST',
                message: `Unsupported screenshot format: ${format}. Supported: png, jpeg, webp`,
                retryable: false,
              },
            });
          }

          const artifact = await service.screenshot(sessionId, pageId, {
            ...(body.fullPage !== undefined ? { fullPage: body.fullPage } : {}),
            format: format as 'png' | 'jpeg' | 'webp',
            ...(body.quality !== undefined ? { quality: body.quality } : {}),
            ...(body.maskSensitive !== undefined ? { maskSensitive: body.maskSensitive } : {}),
          });
          return reply.send(artifact);
        })
      );
    },
    { prefix: '/v1' }
  );

  // Error handler
  fastify.setErrorHandler((error: FastifyError, _request, reply) => {
    fastify.log.error(error);

    // Don't convert Fastify's built-in errors - let them pass with their original status
    if (error.code?.startsWith('FST_ERR_')) {
      return reply.status(error.statusCode || 500).send({
        error: {
          code: error.statusCode === 404 ? 'NOT_FOUND' : 'INVALID_REQUEST',
          message: error.message || 'Request failed',
          retryable: false,
        },
      });
    }

    // For 4xx client errors, return the original status code with INVALID_REQUEST
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        error: {
          code: 'INVALID_REQUEST',
          message: error.message || 'Invalid request',
          retryable: false,
        },
      });
    }

    // For all other errors, return 500 INTERNAL
    return reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: 'An unexpected error occurred',
        retryable: false,
      },
    });
  });

  // 404 handler
  fastify.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        retryable: false,
      },
    });
  });

  return fastify;
}

export async function startServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const server = await buildServer(options);
  // PORT/HOST let a supervisor (the SDK's managed launcher, containers)
  // place the server without code changes.
  const port = options.port ?? envPort() ?? 3000;
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';

  await server.listen({ port, host });
  console.log(`Server listening on ${host}:${port}`);

  return server;
}

/** Parse PORT into a valid integer, ignoring junk rather than crashing. */
function envPort(): number | undefined {
  const raw = process.env.PORT;
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : undefined;
}
