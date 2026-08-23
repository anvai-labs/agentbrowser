/**
 * AgentBrowser REST API Server
 *
 * Fastify-based REST API server providing session management, navigation,
 * observation, and action execution endpoints.
 */

import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import { buildOpenApiDocument } from './openapi.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  corsOrigin?: string | string[];
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

  // Security headers
  fastify.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '1; mode=block');
  });

  // In-memory session storage for testing
  const sessions = new Map<string, any>();
  const pages = new Map<string, any>();

  // Session management endpoints
  fastify.post('/sessions', async (request, reply) => {
    try {
      const body = request.body as any;

      if (!body.tenantId) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_REQUEST',
            message: 'tenantId is required',
            retryable: false,
          },
        });
      }

      const sessionId = `ses_${Date.now()}`;
      const session = {
        sessionId,
        status: 'ready',
        metadata: {
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 900000).toISOString(),
        },
      };

      sessions.set(sessionId, session);

      return reply.status(201).send(session);
    } catch (error) {
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: false,
        },
      });
    }
  });

  // Health check endpoint
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
      return reply.send({
        sessions: Array.from(sessions.values()).map((session) => ({
          sessionId: session.sessionId,
          status: session.status,
          metadata: session.metadata,
        })),
      });
    } catch (error) {
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: false,
        },
      });
    }
  });

  fastify.get('/sessions/:sessionId', async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
      const session = sessions.get(sessionId);

      if (!session) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Session ${sessionId} not found`,
            retryable: false,
          },
        });
      }

      return reply.send(session);
    } catch (error) {
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: false,
        },
      });
    }
  });

  fastify.delete('/sessions/:sessionId', async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
      const session = sessions.get(sessionId);

      if (!session) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Session ${sessionId} not found`,
            retryable: false,
          },
        });
      }

      sessions.delete(sessionId);

      return reply.send({
        sessionId,
        status: 'closed',
      });
    } catch (error) {
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: false,
        },
      });
    }
  });

  // Page management endpoints
  fastify.post('/sessions/:sessionId/pages', async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };

      if (!sessionId) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_REQUEST',
            message: 'sessionId is required',
            retryable: false,
          },
        });
      }

      const session = sessions.get(sessionId);

      if (!session) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Session ${sessionId} not found`,
            retryable: false,
          },
        });
      }

      const pageId = `pg_${Date.now()}`;
      const page = {
        pageId,
        sessionId,
        status: 'ready',
        url: null,
        title: null,
      };

      pages.set(pageId, page);

      return reply.status(201).send(page);
    } catch (error) {
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: false,
        },
      });
    }
  });

  fastify.get('/sessions/:sessionId/pages/:pageId', async (request, reply) => {
    try {
      const { sessionId, pageId } = request.params as { sessionId: string; pageId: string };
      const page = pages.get(pageId);

      if (!page || page.sessionId !== sessionId) {
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
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: false,
        },
      });
    }
  });

  fastify.delete('/sessions/:sessionId/pages/:pageId', async (request, reply) => {
    try {
      const { sessionId, pageId } = request.params as { sessionId: string; pageId: string };
      const page = pages.get(pageId);

      if (!page || page.sessionId !== sessionId) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Page ${pageId} not found`,
            retryable: false,
          },
        });
      }

      pages.delete(pageId);

      return reply.send({
        pageId,
        sessionId,
        status: 'closed',
      });
    } catch (error) {
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: false,
        },
      });
    }
  });

  // Navigation endpoints
  fastify.post('/sessions/:sessionId/pages/:pageId/navigate', async (request, reply) => {
    try {
      const { sessionId, pageId } = request.params as { sessionId: string; pageId: string };
      const body = request.body as any;

      if (!body.url) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_REQUEST',
            message: 'URL is required',
            retryable: false,
          },
        });
      }

      // Validate URL format
      try {
        new URL(body.url);
      } catch {
        return reply.status(400).send({
          error: {
            code: 'INVALID_REQUEST',
            message: 'Invalid URL format',
            retryable: false,
          },
        });
      }

      const page = pages.get(pageId);
      if (!page || page.sessionId !== sessionId) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Page ${pageId} not found in session ${sessionId}`,
            retryable: false,
          },
        });
      }

      // Update page with navigation info
      page.url = body.url;
      page.title = 'Page Title';
      pages.set(pageId, page);

      return reply.send({
        status: 'success',
        url: body.url,
        redirectChain: [],
      });
    } catch (error) {
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: false,
        },
      });
    }
  });

  // Observation endpoints
  fastify.post('/sessions/:sessionId/pages/:pageId/observe', async (request, reply) => {
    try {
      const { sessionId, pageId } = request.params as { sessionId: string; pageId: string };
      const body = request.body as any;

      const page = pages.get(pageId);
      if (!page || page.sessionId !== sessionId) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Page ${pageId} not found`,
            retryable: false,
          },
        });
      }

      // Mock observation result
      return reply.send({
        sessionId,
        pageId,
        revision: 1,
        url: 'https://example.com',
        title: 'Example Page',
        status: 'interactive',
        summary: 'Page with 2 buttons, 1 link',
        elements: [
          {
            ref: 'e1_0',
            role: 'button',
            name: 'Submit',
            visible: true,
            enabled: true,
          },
          {
            ref: 'e1_1',
            role: 'link',
            name: 'Home',
            visible: true,
            enabled: true,
          },
        ],
        truncated: false,
        untrustedContent: true,
      });
    } catch (error) {
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: false,
        },
      });
    }
  });

  // Action execution endpoints
  fastify.post('/sessions/:sessionId/pages/:pageId/act', async (request, reply) => {
    try {
      const { sessionId, pageId } = request.params as { sessionId: string; pageId: string };
      const body = request.body as any;

      // Validate request body
      if (!body.action || !body.target || !body.target.ref) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_REQUEST',
            message: 'Action and target.ref are required',
            retryable: false,
          },
        });
      }

      const page = pages.get(pageId);
      if (!page || page.sessionId !== sessionId) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Page ${pageId} not found`,
            retryable: false,
          },
        });
      }

      // Validate ref format (e<revision>_<ordinal>)
      const refMatch = body.target.ref.match(/^e(\d+)_(\d+)$/);
      if (!refMatch) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_REQUEST',
            message: `Invalid element reference format: ${body.target.ref}`,
            retryable: false,
          },
        });
      }

      const refRevision = Number.parseInt(refMatch[1], 10);

      // Check if ref is stale (revision mismatch with current page state)
      // For MVP, we assume current revision is 1 for testing
      const currentRevision = 1;
      if (refRevision !== currentRevision) {
        return reply.status(400).send({
          error: {
            code: 'STALE_TARGET',
            message: `Element reference is stale. Expected revision ${refRevision}, but current revision is ${currentRevision}`,
            retryable: true,
          },
        });
      }

      // Mock action result
      return reply.send({
        status: 'success',
        actionId: `act_${Date.now()}`,
        newRevision: 2,
      });
    } catch (error) {
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: false,
        },
      });
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

      const page = pages.get(pageId);
      if (!page || page.sessionId !== sessionId) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Page ${pageId} not found`,
            retryable: false,
          },
        });
      }

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

      // Mock artifact - real capture arrives with the engine wiring
      const artifactId = `art_${Date.now()}`;
      return reply.send({
        artifactId,
        type: 'screenshot',
        contentType,
        sizeBytes: 1024,
        url: `/sessions/${sessionId}/artifacts/${artifactId}`,
      });
    } catch (error) {
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: false,
        },
      });
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

    // For all other errors, return 500 INTERNAL_ERROR
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
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
