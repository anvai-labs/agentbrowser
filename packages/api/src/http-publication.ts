import { finished } from 'node:stream/promises';
import type { PublicationContext } from '@agentbrowser/control';
import type { FastifyReply, FastifyRequest } from 'fastify';

interface HttpPublication<T> {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  publish(value: T, context: PublicationContext): Promise<void>;
}

interface HttpOutput {
  publication<T>(body?: (value: T) => unknown): HttpPublication<T>;
}

/** Authority owns the deadline; the transport owns only disconnect and byte delivery. */
export const HTTP_PUBLICATION_TIMEOUT_MS = 10_000;

export function createHttpPublication() {
  const guards = new WeakMap<FastifyRequest, () => void>();
  const terminate = (reply: FastifyReply) => {
    reply.hijack();
    reply.raw.destroy();
  };
  return {
    /** Install before execution. A disconnect cancels output, never replays an effect. */
    async respond(
      request: FastifyRequest,
      reply: FastifyReply,
      work: (output: HttpOutput) => Promise<unknown>
    ) {
      const controller = new AbortController();
      const disconnect = () => controller.abort();
      const close = () => {
        if (!reply.raw.writableFinished) disconnect();
      };
      request.raw.once('aborted', disconnect);
      reply.raw.once('close', close);
      if (request.raw.aborted || reply.raw.destroyed) disconnect();
      const output: HttpOutput = {
        publication<T>(body: (value: T) => unknown = (value) => value): HttpPublication<T> {
          return {
            timeoutMs: HTTP_PUBLICATION_TIMEOUT_MS,
            signal: controller.signal,
            async publish(value: T, context: PublicationContext) {
              if (guards.has(request)) {
                terminate(reply);
                throw new Error('HTTP publication already installed');
              }
              // Retain this guard even after cancellation: a late hook must fail closed.
              guards.set(request, context.assertCurrent);
              const abort = () => terminate(reply);
              context.signal.addEventListener('abort', abort, { once: true });
              try {
                context.assertCurrent();
                // Observe finish before send: a synchronous send can set writableEnded
                // before Fastify's reply thenable installs its completion listener.
                const completion = finished(reply.raw, { cleanup: true });
                void completion.catch(() => undefined);
                reply.send(body(value));
                await completion;
                context.assertCurrent();
              } catch (error) {
                terminate(reply);
                throw error;
              } finally {
                context.signal.removeEventListener('abort', abort);
              }
            },
          };
        },
      };
      try {
        await work(output);
        if (!guards.has(request)) {
          terminate(reply);
          throw new Error('HTTP publication unavailable');
        }
        return reply;
      } finally {
        request.raw.removeListener('aborted', disconnect);
        reply.raw.removeListener('close', close);
      }
    },
    // No asynchronous gap between the final owner check and Fastify's send.
    // Route hooks run after global hooks; finished() above owns completion.
    onSend(
      request: FastifyRequest,
      reply: FastifyReply,
      payload: unknown,
      done: (error: Error | null, payload?: unknown) => void
    ) {
      const guard = guards.get(request);
      try {
        if (guard) guard();
        else if (reply.statusCode < 400) throw new Error('Missing HTTP publication');
      } catch {
        terminate(reply);
        done(new Error('HTTP publication unavailable'));
        return;
      }
      done(null, payload);
    },
    async onError(request: FastifyRequest, reply: FastifyReply) {
      if (guards.has(request)) terminate(reply);
    },
  };
}
