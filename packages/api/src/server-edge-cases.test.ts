/**
 * Edge-branch coverage for the Fastify server layer: env-plumbed
 * configuration, bearer/tenant enforcement on every route family, WS
 * cross-tenant denial, the fastify error handler branches and the
 * PORT/HOST launcher parsing.
 */

import { createHash } from 'node:crypto';
import { StructuredLogger } from '@agentbrowser/core';
import type { BrowserEngine } from '@agentbrowser/engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer, startServer } from './server.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const keyMap = (pairs: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(pairs).map(([key, tenant]) => [sha256(key), tenant]));

/** Bind a probe listener to see whether a port is free, then release it. */
async function portFree(port: number): Promise<boolean> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

describe('server edge branches', () => {
  describe('AGENTBROWSER_API_KEYS parsing', () => {
    const ENV = 'AGENTBROWSER_API_KEYS';
    let original: string | undefined;

    const withEnv = (value: string | undefined, run: () => Promise<void>) => async () => {
      original = process.env[ENV];
      if (value === undefined) delete process.env[ENV];
      else process.env[ENV] = value;
      try {
        await run();
      } finally {
        if (original === undefined) delete process.env[ENV];
        else process.env[ENV] = original;
      }
    };

    it(
      'parses trimmed, multi-colon and junk pairs; unknown or absent bearers are rejected',
      withEnv('k1:tenant-a, k2:tenant-b , brokenpair, :orphan, ghost:, deep:key:x', async () => {
        const server = await buildServer({ engine: new FakeEngine() });
        try {
          // With keys configured, requests without credentials never reach routes.
          const anonymous = await server.inject({ method: 'POST', url: '/v1/sessions' });
          expect(anonymous.statusCode).toBe(401);
          expect(anonymous.json().error.code).toBe('UNAUTHORIZED');

          // A pair without a separator is skipped: it authenticates nothing.
          const junk = await server.inject({
            method: 'POST',
            url: '/v1/sessions',
            headers: { authorization: 'Bearer brokenpair' },
          });
          expect(junk.statusCode).toBe(401);

          // The key wins over a mismatching body tenant, proving which
          // tenant each parsed pair mapped to. 'deep:key:x' proves the
          // last-colon split: the key itself contains colons.
          for (const [key, tenant] of [
            ['k1', 'tenant-a'],
            ['k2', 'tenant-b'],
            ['deep:key', 'x'],
          ] as const) {
            const mismatch = await server.inject({
              method: 'POST',
              url: '/v1/sessions',
              headers: { authorization: `Bearer ${key}` },
              payload: { tenantId: 'someone-else' },
            });
            expect(mismatch.statusCode).toBe(403);
            expect(mismatch.json().error.message).toBe(`API key belongs to tenant ${tenant}.`);
          }
        } finally {
          await server.close();
        }
      })
    );

    it(
      'treats a whitespace-only variable as unset and runs unauthenticated',
      withEnv('   ', async () => {
        const server = await buildServer({ engine: new FakeEngine() });
        try {
          const created = await server.inject({
            method: 'POST',
            url: '/v1/sessions',
            payload: { tenantId: 't1' },
          });
          expect(created.statusCode).toBe(201);
        } finally {
          await server.close();
        }
      })
    );

    it(
      'rejects session creation without any tenantId in unauthenticated mode',
      withEnv(undefined, async () => {
        const server = await buildServer({ engine: new FakeEngine() });
        try {
          const missing = await server.inject({ method: 'POST', url: '/v1/sessions', payload: {} });
          expect(missing.statusCode).toBe(400);
          expect(missing.json().error).toMatchObject({
            code: 'INVALID_REQUEST',
            message: 'tenantId is required',
          });
        } finally {
          await server.close();
        }
      })
    );
  });

  describe('operator configuration', () => {
    it('applies an approval policy from the environment to every session', async () => {
      const ENV = 'AGENTBROWSER_APPROVAL_POLICY';
      const original = process.env[ENV];
      process.env[ENV] = '{"rules":[{"effect":"write-local","decision":"deny","action":"click"}]}';
      let server: Awaited<ReturnType<typeof buildServer>> | undefined;
      try {
        server = await buildServer({ engine: new FakeEngine() });
        const created = await server.inject({
          method: 'POST',
          url: '/v1/sessions',
          payload: { tenantId: 't1' },
        });
        const { sessionId } = created.json();
        const page = await server.inject({
          method: 'POST',
          url: `/v1/sessions/${sessionId}/pages`,
        });
        const { pageId } = page.json();
        await server.inject({
          method: 'POST',
          url: `/v1/sessions/${sessionId}/pages/${pageId}/navigate`,
          payload: { url: 'https://example.com/' },
        });
        const observation = await server.inject({
          method: 'POST',
          url: `/v1/sessions/${sessionId}/pages/${pageId}/observe`,
          payload: {},
        });
        const ref = observation.json().elements[0]?.ref;
        const denied = await server.inject({
          method: 'POST',
          url: `/v1/sessions/${sessionId}/pages/${pageId}/act`,
          payload: { action: 'click', target: { ref } },
        });
        expect(denied.statusCode).toBe(403);
        expect(denied.json().error.message).toMatch(/denies 'write-local' actions/);
      } finally {
        if (original === undefined) delete process.env[ENV];
        else process.env[ENV] = original;
        await server?.close();
      }
    });

    it('applies the deployment default idle timeout', async () => {
      const server = await buildServer({
        engine: new FakeEngine(),
        defaultIdleTimeoutMs: 1_234_567,
      });
      try {
        const created = await server.inject({
          method: 'POST',
          url: '/v1/sessions',
          payload: { tenantId: 't1' },
        });
        expect(created.statusCode).toBe(201);
        expect(created.json().idleTimeoutMs).toBe(1_234_567);
      } finally {
        await server.close();
      }
    });

    it('maps engine capability failure on readiness to a 503 envelope', async () => {
      const broken = {
        name: 'broken-engine',
        version: '0.0.0',
        capabilities: async () => {
          throw new Error('engine dead');
        },
        createSession: async () => {
          throw new Error('engine dead');
        },
        close: async () => undefined,
      } as unknown as BrowserEngine;
      const server = await buildServer({ engine: broken });
      try {
        const ready = await server.inject({ method: 'GET', url: '/health/ready' });
        expect(ready.statusCode).toBe(503);
        expect(ready.json().error).toMatchObject({
          code: 'ENGINE_CRASHED',
          retryable: true,
        });
        expect(ready.json().error.message).toContain('engine dead');
      } finally {
        await server.close();
      }
    });

    it('maps session policy fields onto the engine session', async () => {
      const engine = new FakeEngine();
      const createSession = vi.spyOn(engine, 'createSession');
      const server = await buildServer({ engine });
      try {
        const created = await server.inject({
          method: 'POST',
          url: '/v1/sessions',
          payload: {
            tenantId: 't1',
            cookies: [{ name: 'sid', value: 'v', domain: 'example.com', path: '/' }],
            policy: {
              blockedHosts: ['blocked.example'],
              allowDownloads: true,
              maxDownloadBytes: 4096,
            },
          },
        });
        expect(created.statusCode).toBe(201);
        expect(createSession).toHaveBeenCalledWith(
          expect.objectContaining({
            cookies: [{ name: 'sid', value: 'v', domain: 'example.com', path: '/' }],
            downloadPolicy: { allow: true, maxBytes: 4096 },
          })
        );
      } finally {
        await server.close();
      }
    });
  });

  describe('per-tenant route enforcement', () => {
    let server: Awaited<ReturnType<typeof buildServer>>;
    const operatorA = { authorization: 'Bearer key-a' };
    const operatorB = { authorization: 'Bearer key-b' };
    let sessionId: string;
    let pageId: string;

    beforeAll(async () => {
      server = await buildServer({
        engine: new FakeEngine(),
        apiKeys: keyMap({ 'key-a': 'tenant-a', 'key-b': 'tenant-b' }),
        downloader: async () => ({
          bytes: new TextEncoder().encode('file-bytes'),
          contentType: 'text/plain',
        }),
      });
      const created = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: operatorA,
        payload: { tenantId: 'tenant-a', policy: { allowDownloads: true } },
      });
      sessionId = created.json().sessionId;
      const page = await server.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/pages`,
        headers: operatorA,
      });
      pageId = page.json().pageId;
    });

    afterAll(async () => {
      await server.close();
    });

    const expectForbidden = async (
      method: 'GET' | 'POST' | 'DELETE',
      url: string,
      payload?: unknown
    ) => {
      const response = await server.inject({ method, url, headers: operatorB, payload });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json().error.message, `${method} ${url}`).toBe(
        `Session ${sessionId} belongs to another tenant.`
      );
    };

    it('rejects cross-tenant reads of session-scoped resources', async () => {
      await expectForbidden('GET', `/v1/sessions/${sessionId}/cookies`);
      await expectForbidden('GET', `/v1/sessions/${sessionId}/events/replay`);
      await expectForbidden('GET', `/v1/sessions/${sessionId}/pages/${pageId}/snapshot`);
      await expectForbidden('GET', `/v1/sessions/${sessionId}/pages/${pageId}`);
      await expectForbidden('GET', `/v1/sessions/${sessionId}/pages`);
    });

    it('rejects cross-tenant writes on every action family', async () => {
      await expectForbidden('POST', `/v1/sessions/${sessionId}/trace`, {});
      await expectForbidden('POST', `/v1/sessions/${sessionId}/pages/${pageId}/html`, {});
      await expectForbidden('POST', `/v1/sessions/${sessionId}/pages/${pageId}/plan`, {
        actions: [],
      });
      await expectForbidden('POST', `/v1/sessions/${sessionId}/pages`, {});
      await expectForbidden('POST', `/v1/sessions/${sessionId}/pages/${pageId}/navigate`, {
        url: 'https://example.com/',
      });
      await expectForbidden('POST', `/v1/sessions/${sessionId}/pages/${pageId}/observe`, {});
      await expectForbidden('POST', `/v1/sessions/${sessionId}/pages/${pageId}/act`, {
        action: 'press',
        key: 'Tab',
      });
      await expectForbidden('POST', `/v1/sessions/${sessionId}/pages/${pageId}/download`, {
        url: 'https://files.example.com/a',
      });
      await expectForbidden(
        'POST',
        `/v1/sessions/${sessionId}/pages/${pageId}/downloads/report.csv`,
        {}
      );
      await expectForbidden('POST', `/v1/sessions/${sessionId}/pages/${pageId}/pdf`, {});
      await expectForbidden('POST', `/v1/sessions/${sessionId}/pages/${pageId}/extract`, {
        format: 'text',
      });
      await expectForbidden('POST', `/v1/sessions/${sessionId}/pages/${pageId}/screenshot`, {});
    });

    it('rejects cross-tenant destructive operations without executing them', async () => {
      await expectForbidden('DELETE', `/v1/sessions/${sessionId}`);
      await expectForbidden('DELETE', `/v1/sessions/${sessionId}/pages/${pageId}`);
      const stillThere = await server.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionId}`,
        headers: operatorA,
      });
      expect(stillThere.statusCode).toBe(200);
    });

    it('serves the same routes to the owning tenant', async () => {
      const inject = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
        server.inject({ method, url, headers: operatorA, payload });

      await inject('POST', `/v1/sessions/${sessionId}/pages/${pageId}/navigate`, {
        url: 'https://example.com/',
      });

      const cookies = await inject('GET', `/v1/sessions/${sessionId}/cookies`);
      expect(cookies.statusCode).toBe(200);
      expect(cookies.json()).toEqual({ cookies: [] });

      const replay = await inject('GET', `/v1/sessions/${sessionId}/events/replay`);
      expect(replay.statusCode).toBe(200);
      expect(Array.isArray(replay.json().events)).toBe(true);

      const snapshot = await inject('GET', `/v1/sessions/${sessionId}/pages/${pageId}/snapshot`);
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json()).toMatchObject({ url: 'https://example.com/' });

      const observation = await inject(
        'POST',
        `/v1/sessions/${sessionId}/pages/${pageId}/observe`,
        {}
      );
      const ref = observation.json().elements[0]?.ref;

      const act = await inject('POST', `/v1/sessions/${sessionId}/pages/${pageId}/act`, {
        action: 'click',
        target: { ref },
      });
      expect(act.statusCode).toBe(200);
      expect(act.json().status).toBe('success');

      const plan = await inject('POST', `/v1/sessions/${sessionId}/pages/${pageId}/plan`, {
        actions: [],
      });
      expect(plan.statusCode).toBe(200);
      expect(plan.json()).toMatchObject({ ok: true, completed: 0 });

      const trace = await inject('POST', `/v1/sessions/${sessionId}/trace`, {});
      expect(trace.statusCode).toBe(201);
      expect(trace.json().artifactId).toEqual(expect.any(String));

      const html = await inject('POST', `/v1/sessions/${sessionId}/pages/${pageId}/html`, {});
      expect(html.statusCode).toBe(201);

      const pdf = await inject('POST', `/v1/sessions/${sessionId}/pages/${pageId}/pdf`, {
        landscape: true,
        displayHeaderFooter: true,
        printBackground: true,
      });
      expect(pdf.statusCode).toBe(200);
      expect(pdf.json().contentType).toBe('application/pdf');

      const extract = await inject('POST', `/v1/sessions/${sessionId}/pages/${pageId}/extract`, {
        format: 'text',
      });
      expect(extract.statusCode).toBe(200);

      const screenshot = await inject(
        'POST',
        `/v1/sessions/${sessionId}/pages/${pageId}/screenshot`,
        {}
      );
      expect(screenshot.statusCode).toBe(200);

      const download = await inject('POST', `/v1/sessions/${sessionId}/pages/${pageId}/download`, {
        url: 'https://files.example.com/report.txt',
        filename: 'report.txt',
      });
      expect(download.statusCode).toBe(200);
      expect(download.json().contentType).toBe('text/plain');

      // Collect an intercepted download: the engine has none pending, so the
      // route surfaces the typed NOT_FOUND guidance.
      const collected = await inject(
        'POST',
        `/v1/sessions/${sessionId}/pages/${pageId}/downloads/missing.csv`,
        {}
      );
      expect(collected.statusCode).toBe(404);
      expect(collected.json().error.code).toBe('NOT_FOUND');

      // Only some pdf options set: the unset ones stay absent from the
      // service request.
      const pdfPartial = await inject('POST', `/v1/sessions/${sessionId}/pages/${pageId}/pdf`, {
        landscape: true,
      });
      expect(pdfPartial.statusCode).toBe(200);
    });

    it('validates request bodies per route', async () => {
      const inject = (
        method: 'GET' | 'POST',
        url: string,
        payload?: unknown,
        headers: Record<string, string> = {}
      ) => server.inject({ method, url, headers: { ...operatorA, ...headers }, payload });

      const urlType = await inject('POST', `/v1/sessions/${sessionId}/pages`, { url: 42 });
      expect(urlType.statusCode).toBe(400);
      expect(urlType.json().error.message).toBe('url must be a string');

      const navigateEmpty = await inject(
        'POST',
        `/v1/sessions/${sessionId}/pages/${pageId}/navigate`
      );
      expect(navigateEmpty.statusCode).toBe(400);
      expect(navigateEmpty.json().error.message).toBe('A JSON request body is required');

      const navigateNoUrl = await inject(
        'POST',
        `/v1/sessions/${sessionId}/pages/${pageId}/navigate`,
        {}
      );
      expect(navigateNoUrl.statusCode).toBe(400);
      expect(navigateNoUrl.json().error.message).toBe('url is required and must be a string');

      const downloadEmpty = await inject(
        'POST',
        `/v1/sessions/${sessionId}/pages/${pageId}/download`
      );
      expect(downloadEmpty.statusCode).toBe(400);
      expect(downloadEmpty.json().error.message).toBe('A JSON request body is required');

      const downloadNoUrl = await inject(
        'POST',
        `/v1/sessions/${sessionId}/pages/${pageId}/download`,
        {}
      );
      expect(downloadNoUrl.statusCode).toBe(400);
      expect(downloadNoUrl.json().error.message).toBe('url is required and must be a string');

      const actEmpty = await inject('POST', `/v1/sessions/${sessionId}/pages/${pageId}/act`);
      expect(actEmpty.statusCode).toBe(400);
      expect(actEmpty.json().error.message).toBe('A JSON request body is required');

      const extractEmpty = await inject(
        'POST',
        `/v1/sessions/${sessionId}/pages/${pageId}/extract`
      );
      expect(extractEmpty.statusCode).toBe(400);
      expect(extractEmpty.json().error.message).toBe('A JSON request body is required');
    });
  });

  describe('WebSocket cross-tenant denial', () => {
    it('closes a cross-tenant event stream with 4403', async () => {
      const server = await buildServer({
        engine: new FakeEngine(),
        apiKeys: keyMap({ 'key-a': 'tenant-a', 'key-b': 'tenant-b' }),
      });
      try {
        const created = await server.inject({
          method: 'POST',
          url: '/v1/sessions',
          headers: { authorization: 'Bearer key-a' },
          payload: { tenantId: 'tenant-a' },
        });
        const { sessionId } = created.json();
        await server.listen({ port: 0, host: '127.0.0.1' });
        const address = server.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const wsUrl = `ws://127.0.0.1:${port}/v1/sessions/${sessionId}/events`;
        const socket = new WebSocket(wsUrl, {
          headers: { authorization: 'Bearer key-b' },
        } as never);
        const closed = new Promise<number>((resolve) => {
          socket.addEventListener('close', (event) => resolve(event.code));
        });
        expect(await closed).toBe(4403);
      } finally {
        await server.close();
      }
    });
  });

  describe('collected download happy path', () => {
    it('stores a pending intercepted download as an artifact', async () => {
      const engine = new FakeEngine();
      const server = await buildServer({ engine });
      try {
        const created = await server.inject({
          method: 'POST',
          url: '/v1/sessions',
          payload: { tenantId: 't1', policy: { allowDownloads: true } },
        });
        const { sessionId } = created.json();
        const page = await server.inject({
          method: 'POST',
          url: `/v1/sessions/${sessionId}/pages`,
        });
        const { pageId } = page.json();
        const engineSession = engine.getSession(engine.getSessionIds()[0] as string);
        if (!engineSession) throw new Error('no engine session');
        (
          engineSession as unknown as {
            takeDownload: () => Promise<{ bytes: Uint8Array; filename: string }>;
          }
        ).takeDownload = async () => ({
          bytes: new TextEncoder().encode('a,b\n1,2'),
          filename: 'export.csv',
        });
        const collected = await server.inject({
          method: 'POST',
          url: `/v1/sessions/${sessionId}/pages/${pageId}/downloads/whatever`,
        });
        expect(collected.statusCode).toBe(200);
        expect(collected.json()).toMatchObject({
          contentType: 'text/csv',
          filename: 'export.csv',
        });
      } finally {
        await server.close();
      }
    });
  });

  describe('internal failure envelope', () => {
    it('preserves the safe error envelope when the logger sink throws', async () => {
      const sink = vi.fn(() => {
        throw new Error('PRIVATE_SINK_DIAGNOSTIC');
      });
      const server = await buildServer({
        engine: new FakeEngine(),
        logger: new StructuredLogger({ sink }),
        metrics: {
          render() {
            throw new Error('PRIVATE_HANDLER_DIAGNOSTIC');
          },
        } as never,
      });
      try {
        const response = await server.inject({ method: 'GET', url: '/metrics' });
        expect(sink).toHaveBeenCalledOnce();
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({
          error: {
            code: 'INTERNAL',
            message: 'An unexpected error occurred',
            retryable: false,
          },
        });
        expect(response.body).not.toContain('PRIVATE_SINK_DIAGNOSTIC');
        expect(response.body).not.toContain('PRIVATE_HANDLER_DIAGNOSTIC');
      } finally {
        await server.close();
      }
    });

    it('escapes root-route handler failures into the custom INTERNAL envelope', async () => {
      // The error handler is registered before any awaited plugin, so it
      // governs routes registered earlier too: an unauthenticated /metrics
      // failure returns the generic INTERNAL envelope, never the raw
      // internal error text.
      const explodingMetrics = {
        render: () => {
          throw new Error('metrics exploded');
        },
      } as never;
      const server = await buildServer({
        engine: new FakeEngine(),
        metrics: explodingMetrics,
      });
      try {
        const response = await server.inject({ method: 'GET', url: '/metrics' });
        expect(response.statusCode).toBe(500);
        expect(response.json().error).toMatchObject({
          code: 'INTERNAL',
          retryable: false,
        });
        // The generic envelope must not smuggle the internal message out.
        expect(response.body).not.toContain('metrics exploded');
      } finally {
        await server.close();
      }
    });

    it('survives handler failures whose error has a non-string code', async () => {
      // A numeric-code convention (e.g. 11000) thrown through an injected
      // component must not crash the handler itself — a truthy non-string
      // code made the FST prefix check throw, falling back to fastify's
      // default serializer and bypassing the envelope entirely.
      const explodingMetrics = {
        render: () => {
          throw { code: 11000, message: 'driver failure' };
        },
      } as never;
      const server = await buildServer({
        engine: new FakeEngine(),
        metrics: explodingMetrics,
      });
      try {
        const response = await server.inject({ method: 'GET', url: '/metrics' });
        expect(response.statusCode).toBe(500);
        expect(response.json().error).toMatchObject({ code: 'INTERNAL', retryable: false });
        expect(response.body).not.toContain('driver failure');
      } finally {
        await server.close();
      }
    });
  });

  describe('fastify error handler', () => {
    // One error contract on both route planes: the handler is registered
    // before any awaited plugin, so root-route handler failures get the
    // INTERNAL envelope, /v1 parser errors the INVALID_REQUEST envelope,
    // and fastify built-ins keep their original statuses.
    it('keeps fastify built-in error statuses for FST errors on root routes', async () => {
      const server = await buildServer({ engine: new FakeEngine() });
      try {
        const tooLarge = await server.inject({
          method: 'POST',
          url: '/metrics',
          headers: { 'content-type': 'application/json' },
          payload: `{"blob":"${'y'.repeat(2 * 1024 * 1024)}"}`,
        });
        expect(tooLarge.statusCode).toBe(413);
        expect(tooLarge.json().error).toMatchObject({
          code: 'INVALID_REQUEST',
          retryable: false,
          message: 'Request body is too large',
        });
      } finally {
        await server.close();
      }
    });

    it('wraps root-route client-side payload errors as INVALID_REQUEST', async () => {
      const server = await buildServer({ engine: new FakeEngine() });
      try {
        const malformed = await server.inject({
          method: 'POST',
          url: '/metrics',
          headers: { 'content-type': 'application/json' },
          payload: '{definitely not json',
        });
        expect(malformed.statusCode).toBe(400);
        expect(malformed.json().error).toMatchObject({
          code: 'INVALID_REQUEST',
          retryable: false,
          message: 'Invalid JSON body',
        });
      } finally {
        await server.close();
      }
    });

    it('serves /v1 parser errors with the protocol envelope too', async () => {
      // Both route planes share one error contract: parser-stage errors on
      // /v1 go through the same { error: { code, ... } } envelope as root
      // routes.
      const server = await buildServer({ engine: new FakeEngine() });
      try {
        const malformed = await server.inject({
          method: 'POST',
          url: '/v1/sessions',
          headers: { 'content-type': 'application/json' },
          payload: '{definitely not json',
        });
        expect(malformed.statusCode).toBe(400);
        expect(malformed.json().error).toMatchObject({
          code: 'INVALID_REQUEST',
          retryable: false,
          message: 'Invalid JSON body',
        });
      } finally {
        await server.close();
      }
    });
  });

  describe('startServer launcher', () => {
    type RunningServer = Awaited<ReturnType<typeof startServer>>;

    it('honors a valid PORT environment variable', async () => {
      const port = 23000 + Math.floor(Math.random() * 10000);
      const original = process.env.PORT;
      process.env.PORT = String(port);
      let server: RunningServer | undefined;
      try {
        server = await startServer({ engine: new FakeEngine(), host: '127.0.0.1' });
        const address = server.server.address();
        expect(typeof address === 'object' && address ? address.port : -1).toBe(port);
      } finally {
        if (original === undefined) Reflect.deleteProperty(process.env, 'PORT');
        else process.env.PORT = original;
        await server?.close();
      }
    });

    it('falls back to the default port when PORT is unusable or unset', async () => {
      if (!(await portFree(5709))) {
        return; // Default port already occupied in this environment.
      }
      const original = process.env.PORT;
      // Genuinely unset (assigning undefined would coerce to the string
      // "undefined"): the raw === undefined branch is what envPort declines.
      Reflect.deleteProperty(process.env, 'PORT');
      let server: RunningServer | undefined;
      try {
        server = await startServer({ engine: new FakeEngine(), host: '127.0.0.1' });
        const address = server.server.address();
        expect(typeof address === 'object' && address ? address.port : -1).toBe(5709);
        await server.close();
        server = undefined;
        process.env.PORT = 'not-a-port'; // junk: parsed but out of contract.
        server = await startServer({ engine: new FakeEngine(), host: '127.0.0.1' });
        const address2 = server.server.address();
        expect(typeof address2 === 'object' && address2 ? address2.port : -1).toBe(5709);
      } finally {
        if (original === undefined) Reflect.deleteProperty(process.env, 'PORT');
        else process.env.PORT = original;
        await server?.close();
      }
    });
  });
});
