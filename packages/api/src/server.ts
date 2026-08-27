/**
 * AgentBrowser REST API Server
 *
 * Fastify-based REST API server providing session management, navigation,
 * observation, and action execution endpoints. Routes are a thin translation
 * layer over AgentBrowserService; the engine is injected, so tests run
 * against FakeEngine and production runs PlaywrightChromiumEngine.
 */

import { MetricsRegistry } from '@agentbrowser/core';
import type { StructuredLogger } from '@agentbrowser/core';
import type { BrowserEngine } from '@agentbrowser/engine';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import { buildOpenApiDocument } from './openapi.js';
import { AgentBrowserService, ServiceError } from './service.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  corsOrigin?: string | string[];
  /** Browser engine backing the server. Production must inject a real one. */
  engine?: BrowserEngine;
  /** Download payload fetcher; injectable so tests never touch the network. */
  downloader?(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Metrics registry exposed at /metrics; defaults to a fresh registry. */
  metrics?: MetricsRegistry;
  /** Structured operation log; when absent, no operation logging. */
  logger?: StructuredLogger;
}

/** Map protocol error codes onto HTTP statuses. */
function statusFor(code: string): number {
  switch (code) {
    case 'SESSION_NOT_FOUND':
    case 'NOT_FOUND':
    case 'PAGE_NOT_FOUND':
      return 404;
    case 'POLICY_DENIED':
    case 'APPROVAL_REQUIRED':
    case 'FORBIDDEN':
    case 'DOWNLOAD_BLOCKED':
      return 403;
    case 'QUOTA_EXCEEDED':
      return 429;
    case 'ENGINE_UNSUPPORTED':
      return 422;
    case 'INVALID_REQUEST':
    case 'STALE_TARGET':
    case 'TARGET_NOT_FOUND':
    case 'TARGET_AMBIGUOUS':
    case 'TARGET_NOT_VISIBLE':
    case 'TARGET_DISABLED':
      return 400;
    default:
      return 500;
  }
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
  const service = new AgentBrowserService({
    engine,
    metrics,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.downloader ? { downloader: options.downloader } : {}),
  });

  fastify.addHook('onClose', async () => {
    await service.shutdown();
  });

  /** Translate a service failure into the protocol error envelope. */
  const fail = (reply: import('fastify').FastifyReply, error: unknown) => {
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

  const requireBody = (
    reply: import('fastify').FastifyReply,
    body: unknown
  ): body is Record<string, unknown> => {
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

  // Session management endpoints
  fastify.post('/sessions', async (request, reply) => {
    try {
      const body = request.body;
      if (!requireBody(reply, body)) {
        return reply;
      }

      if (typeof (body as Record<string, unknown>).tenantId !== 'string') {
        return reply.status(400).send({
          error: { code: 'INVALID_REQUEST', message: 'tenantId is required', retryable: false },
        });
      }

      const session = await service.createSession(body as never);
      return reply.status(201).send(session);
    } catch (error) {
      return fail(reply, error);
    }
  });

  // Liveness: is the process serving at all.
  fastify.get('/health/live', async (request, reply) => {
    return { status: 'live', timestamp: new Date().toISOString() };
  });

  // Readiness: can the service actually serve (engine responsive).
  fastify.get('/health/ready', async (request, reply) => {
    try {
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

  // Prometheus exposition.
  fastify.get('/metrics', async (request, reply) => {
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render());
  });

  // Session event stream: WebSocket upgrade, JSON per frame.
  fastify.get('/sessions/:sessionId/events', { websocket: true }, (socket, request) => {
    const { sessionId } = request.params as { sessionId: string };

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

  // Health check endpoint (compat).
  fastify.get('/health', async (request, reply) => {
    return {
      status: 'healthy',
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });

  // Machine-readable API description, so polyglot clients can be generated
  // rather than hand-written.
  const openApiDocument = buildOpenApiDocument();
  fastify.get('/openapi.json', async (_request, reply) => {
    return reply.type('application/json').send(openApiDocument);
  });

  fastify.get('/sessions', async (request, reply) => {
    try {
      return reply.send({ sessions: service.listSessions() });
    } catch (error) {
      return fail(reply, error);
    }
  });

  fastify.get('/sessions/:sessionId', async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
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
    } catch (error) {
      return fail(reply, error);
    }
  });

  fastify.delete('/sessions/:sessionId', async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
      await service.closeSession(sessionId);
      return reply.send({ sessionId, status: 'closed' });
    } catch (error) {
      return fail(reply, error);
    }
  });

  // Page management endpoints
  fastify.post('/sessions/:sessionId/pages', async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
      const page = await service.createPage(sessionId);
      return reply.status(201).send(page);
    } catch (error) {
      return fail(reply, error);
    }
  });

  fastify.get('/sessions/:sessionId/pages/:pageId', async (request, reply) => {
    try {
      const { sessionId, pageId } = request.params as { sessionId: string; pageId: string };
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
    } catch (error) {
      return fail(reply, error);
    }
  });

  fastify.delete('/sessions/:sessionId/pages/:pageId', async (request, reply) => {
    try {
      const { sessionId, pageId } = request.params as { sessionId: string; pageId: string };
      await service.closePage(sessionId, pageId);
      return reply.send({ pageId, status: 'closed' });
    } catch (error) {
      return fail(reply, error);
    }
  });

  // Navigation endpoint
  fastify.post('/sessions/:sessionId/pages/:pageId/navigate', async (request, reply) => {
    try {
      const { sessionId, pageId } = request.params as { sessionId: string; pageId: string };
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
    } catch (error) {
      return fail(reply, error);
    }
  });

  // Observation endpoint
  fastify.post('/sessions/:sessionId/pages/:pageId/observe', async (request, reply) => {
    try {
      const { sessionId, pageId } = request.params as { sessionId: string; pageId: string };
      const observation = await service.observe(sessionId, pageId, (request.body ?? {}) as never);
      return reply.send(observation);
    } catch (error) {
      return fail(reply, error);
    }
  });

  // Action execution endpoint
  fastify.post('/sessions/:sessionId/pages/:pageId/act', async (request, reply) => {
    try {
      const { sessionId, pageId } = request.params as { sessionId: string; pageId: string };
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
        ...(expectedRevision !== undefined ? { expectedRevision: expectedRevision as number } : {}),
        ...(approvalToken !== undefined ? { approvalToken: approvalToken as string } : {}),
        ...(promptText !== undefined ? { promptText: promptText as string } : {}),
      });
      return reply.send(result);
    } catch (error) {
      return fail(reply, error);
    }
  });

  // Download endpoint: policy-gated artifact capture
  fastify.post('/sessions/:sessionId/pages/:pageId/download', async (request, reply) => {
    try {
      const { sessionId, pageId } = request.params as { sessionId: string; pageId: string };
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
    } catch (error) {
      return fail(reply, error);
    }
  });

  // Artifact retrieval, scoped to the owning session
  fastify.get('/sessions/:sessionId/artifacts/:artifactId', async (request, reply) => {
    try {
      const { sessionId, artifactId } = request.params as {
        sessionId: string;
        artifactId: string;
      };
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
    } catch (error) {
      return fail(reply, error);
    }
  });

  // PDF capture endpoint
  fastify.post('/sessions/:sessionId/pages/:pageId/pdf', async (request, reply) => {
    try {
      const { sessionId, pageId } = request.params as { sessionId: string; pageId: string };
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
        ...(body.printBackground !== undefined ? { printBackground: body.printBackground } : {}),
      });
      return reply.send(artifact);
    } catch (error) {
      return fail(reply, error);
    }
  });

  // Extraction endpoint (spec 12): deterministic extractors with evidence
  fastify.post('/sessions/:sessionId/pages/:pageId/extract', async (request, reply) => {
    try {
      const { sessionId, pageId } = request.params as { sessionId: string; pageId: string };
      const body = request.body;
      if (!requireBody(reply, body)) {
        return reply;
      }

      const format = (body as { format?: string }).format;
      const supported = ['text', 'markdown', 'links', 'tables', 'forms', 'jsonld'];
      if (typeof format !== 'string' || !supported.includes(format)) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_REQUEST',
            message: `Unknown format ${String(format)}. Supported: ${supported.join(', ')}`,
            retryable: false,
          },
        });
      }

      const result = await service.extract(sessionId, pageId, { format: format as never });
      return reply.send(result);
    } catch (error) {
      return fail(reply, error);
    }
  });

  // Screenshot endpoint
  fastify.post('/sessions/:sessionId/pages/:pageId/screenshot', async (request, reply) => {
    try {
      const { sessionId, pageId } = request.params as { sessionId: string; pageId: string };
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
    } catch (error) {
      return fail(reply, error);
    }
  });

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
