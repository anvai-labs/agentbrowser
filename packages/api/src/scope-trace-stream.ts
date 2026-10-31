import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentBrowserService } from './service.js';
import { ServiceError } from './service.js';

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
/** Authenticated, bounded, read-only diagnostics; no network policy mutation. */
export function registerScopeTraceStream(
  v1: FastifyInstance,
  service: AgentBrowserService,
  wrap: (handler: Handler) => Handler,
  admit: (request: FastifyRequest, id: string) => void
): void {
  const closers = new Set<
    (reason?: 'session-ended' | 'server-shutdown' | 'revoked' | 'backpressure') => void
  >();
  const perSession = new Map<string, number>();
  v1.addHook('preClose', async () => {
    for (const close of [...closers]) close('server-shutdown');
  });
  v1.get(
    '/sessions/:sessionId/scope/trace',
    { config: { publication: 'stream', capability: 'page.observe' } },
    wrap(async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      admit(request, sessionId);
      if (service.getSession(sessionId)?.trace !== 'denials')
        throw new ServiceError('INVALID_REQUEST', 'Denial tracing is disabled for this session');
      if (request.method === 'HEAD')
        return reply.header('content-type', 'text/event-stream').code(200).send();
      if (closers.size >= 64 || (perSession.get(sessionId) ?? 0) >= 4)
        throw new ServiceError('QUOTA_EXCEEDED', 'Trace observer capacity reached', true, {
          rule: 'floor.trace.capacity',
        });
      let closed = false;
      let stop: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const close = (
        reason: 'session-ended' | 'server-shutdown' | 'revoked' | 'backpressure' = 'session-ended'
      ) => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        stop?.();
        closers.delete(close);
        const count = (perSession.get(sessionId) ?? 1) - 1;
        if (count) perSession.set(sessionId, count);
        else perSession.delete(sessionId);
        if (!reply.raw.destroyed && reply.raw.writableLength <= 64 * 1024)
          reply.raw.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
        reply.raw.end();
      };
      const send = (line: string) => {
        if (closed) return;
        try {
          admit(request, sessionId);
          if (reply.raw.destroyed || reply.raw.writableLength > 64 * 1024) {
            close('backpressure');
            reply.raw.destroy();
            return;
          }
          reply.raw.write(line);
        } catch {
          close('revoked');
        }
      };
      stop = service.subscribe(sessionId, (event) => {
        if (event.type === 'scope.denied' || event.type === 'scope.dependency-starved')
          send(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'page.destroyed' && event.pageId === undefined) close();
      });
      if (!stop) throw new ServiceError('SESSION_NOT_FOUND', 'Session not found');
      perSession.set(sessionId, (perSession.get(sessionId) ?? 0) + 1);
      closers.add(close);
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
      reply.raw.on('close', () => close());
      reply.raw.on('error', () => close('server-shutdown'));
      send(': connected\n\n');
      if (closed) return reply;
      heartbeat = setInterval(() => {
        const view = service.getSession(sessionId);
        if (!view || view.closeCause) close();
        else send(': heartbeat\n\n');
      }, 15000);
      heartbeat.unref();
      return reply;
    })
  );
}
