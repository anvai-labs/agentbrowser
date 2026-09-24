import { setImmediate as settlePublication } from 'node:timers/promises';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { createHttpPublication } from './http-publication.js';
import {
  agentHeaders,
  bindAndDelegate,
  buildApplicationServer,
  operatorHeaders,
} from './test-support/application-counter-http.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it('keeps finalized application execution excluded until the last asynchronous HTTP hook completes', async () => {
  const { server, state } = await buildApplicationServer();
  const entered = deferred();
  const release = deferred();
  server.addHook('onSend', async (request, _reply, payload) => {
    if (request.url.endsWith('/application/execute')) {
      entered.resolve();
      await release.promise;
    }
    return payload;
  });
  try {
    const { path, token } = await bindAndDelegate(server);
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    const response = fetch(`${base}${path}/application/execute`, {
      method: 'POST',
      headers: { ...agentHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'add',
        input: 1,
        operationId: 'published',
        expectedVersion: 0,
      }),
    });
    await entered.promise;
    const status = await server.inject({
      url: `${path}/operations/published`,
      headers: operatorHeaders,
    });
    expect(status.json()).toMatchObject({ status: 'completed', dispatched: true });
    const control = await server.inject({ url: `${path}/control`, headers: operatorHeaders });
    try {
      expect(control.json().busy).toBe(true);
      expect(state.total).toBe(1);
    } finally {
      release.resolve();
      await response;
    }
  } finally {
    release.resolve();
    await server.close();
  }
}, 10_000);

it.each(['fresh', 'replay'] as const)(
  'suppresses %s application bytes when permission is revoked in a late onSend hook',
  async (kind) => {
    let allowed = true;
    const { server, state } = await buildApplicationServer(() => allowed);
    let armed = false;
    server.addHook('onSend', async (request, _reply, payload) => {
      if (armed && request.url.endsWith('/application/execute')) {
        await Promise.resolve();
        allowed = false;
      }
      return payload;
    });
    try {
      const { path, token } = await bindAndDelegate(server);
      const base = await server.listen({ host: '127.0.0.1', port: 0 });
      const send = () =>
        fetch(`${base}${path}/application/execute`, {
          method: 'POST',
          headers: { ...agentHeaders(token), 'content-type': 'application/json' },
          body: JSON.stringify({
            operation: 'add',
            input: 1,
            operationId: 'private-result',
            expectedVersion: 0,
          }),
        });
      if (kind === 'replay') expect((await send()).status).toBe(200);
      armed = true;
      await expect(send()).rejects.toThrow();
      expect(state.total).toBe(1);
      const status = await server.inject({
        url: `${path}/operations/private-result`,
        headers: operatorHeaders,
      });
      expect(status.json()).toMatchObject({ status: 'completed', dispatched: true });
    } finally {
      await server.close();
    }
  },
  10_000
);

it('publishes duplicate status while the original response retains its ticket, without another effect', async () => {
  const { server, state } = await buildApplicationServer();
  const entered = deferred();
  const release = deferred();
  server.addHook('onSend', async (request, _reply, payload) => {
    if (request.headers['x-hold-publication']) {
      entered.resolve();
      await release.promise;
    }
    return payload;
  });
  try {
    const { path, token } = await bindAndDelegate(server);
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    const options = {
      method: 'POST',
      headers: { ...agentHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'add',
        input: 1,
        operationId: 'duplicate',
        expectedVersion: 0,
      }),
    };
    const original = fetch(`${base}${path}/application/execute`, {
      ...options,
      headers: { ...options.headers, 'x-hold-publication': 'yes' },
    });
    await entered.promise;
    try {
      const replay = await fetch(`${base}${path}/application/execute`, options);
      expect(await replay.json()).toMatchObject({
        replay: true,
        operation: { operationId: 'duplicate', status: 'completed', dispatched: true },
      });
      expect(state.total).toBe(1);
      const control = await server.inject({ url: `${path}/control`, headers: operatorHeaders });
      expect(control.json().busy).toBe(true);
    } finally {
      release.resolve();
      await original;
    }
  } finally {
    release.resolve();
    await server.close();
  }
}, 10_000);

it.each(['disconnect', 'deadline'] as const)(
  'terminates %s output and refuses a deliberately late response hook without changing committed facts',
  async (cause) => {
    const { server, state } = await buildApplicationServer();
    const entered = deferred();
    const release = deferred();
    const late = deferred();
    let raw: import('node:http').ServerResponse | undefined;
    server.addHook('onSend', async (request, reply, payload) => {
      if (request.url.endsWith('/application/execute')) {
        raw = reply.raw;
        entered.resolve();
        await release.promise;
        late.resolve();
      }
      return payload;
    });
    try {
      const { path, token } = await bindAndDelegate(server);
      const base = await server.listen({ host: '127.0.0.1', port: 0 });
      const controller = new AbortController();
      const response = fetch(`${base}${path}/application/execute`, {
        method: 'POST',
        headers: { ...agentHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'add',
          input: 1,
          operationId: cause,
          expectedVersion: 0,
        }),
        signal: controller.signal,
      });
      const refused = expect(response).rejects.toThrow();
      await entered.promise;
      if (cause === 'disconnect') controller.abort();
      await refused;
      await expect
        .poll(
          async () =>
            (await server.inject({ url: `${path}/control`, headers: operatorHeaders })).json().busy
        )
        .toBe(false);
      const status = await server.inject({
        url: `${path}/operations/${cause}`,
        headers: operatorHeaders,
      });
      expect(status.json()).toMatchObject({ status: 'completed', dispatched: true });
      expect(state.total).toBe(1);
      release.resolve();
      await late.promise;
      await settlePublication();
      expect(raw?.headersSent).toBe(false);
      expect(raw?.destroyed).toBe(true);
    } finally {
      release.resolve();
      await server.close();
    }
  },
  25_000
);

it.each(['discovery', 'receipt', 'status'] as const)(
  'guards %s output after a late control takeover',
  async (surface) => {
    const { server } = await buildApplicationServer();
    let target = '';
    let takeover = async () => {};
    server.addHook('onSend', async (request, _reply, payload) => {
      if (request.url === target) await takeover();
      return payload;
    });
    try {
      const { path, token } = await bindAndDelegate(server);
      await server.inject({
        method: 'POST',
        url: `${path}/application/execute`,
        headers: agentHeaders(token),
        payload: { operation: 'add', input: 1, operationId: 'captured', expectedVersion: 0 },
      });
      await settlePublication();
      const base = await server.listen({ host: '127.0.0.1', port: 0 });
      target = `${path}/${surface === 'discovery' ? 'application' : surface === 'receipt' ? 'application/receipts/captured' : 'operations/captured'}`;
      takeover = async () => {
        await server.inject({
          method: 'POST',
          url: `${path}/control/takeover`,
          headers: operatorHeaders,
        });
      };
      await expect(fetch(`${base}${target}`, { headers: agentHeaders(token) })).rejects.toThrow();
    } finally {
      await server.close();
    }
  },
  10_000
);

it('terminates serialization failure without sending private diagnostics or rewriting execution', async () => {
  const { server, state } = await buildApplicationServer();
  server.addHook('preSerialization', async (request, _reply, payload) => {
    if (request.url.endsWith('/application/execute')) throw new Error('PRIVATE SERIALIZER');
    return payload;
  });
  try {
    const { path, token } = await bindAndDelegate(server);
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    await expect(
      fetch(`${base}${path}/application/execute`, {
        method: 'POST',
        headers: { ...agentHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'add',
          input: 1,
          operationId: 'serialization',
          expectedVersion: 0,
        }),
      })
    ).rejects.toThrow();
    expect(state.total).toBe(1);
    const status = await server.inject({
      url: `${path}/operations/serialization`,
      headers: operatorHeaders,
    });
    expect(status.json()).toMatchObject({ status: 'completed' });
  } finally {
    await server.close();
  }
}, 10_000);

it('marks only the qualified routes and preserves HEAD, null receipts and static validation errors', async () => {
  const { server } = await buildApplicationServer();
  try {
    const { path, token } = await bindAndDelegate(server);
    expect(
      server.registeredRoutes
        .filter((route) => route.publication === 'guarded')
        .map(({ method, url }) => `${method} ${url}`)
        .sort()
    ).toEqual([
      'GET /v1/sessions/:sessionId/application',
      'GET /v1/sessions/:sessionId/application/receipts/:operationId',
      'GET /v1/sessions/:sessionId/operations/:operationId',
      'POST /v1/sessions/:sessionId/application/execute',
    ]);
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    for (const suffix of ['application', 'application/receipts/missing']) {
      const response = await fetch(`${base}${path}/${suffix}`, {
        method: 'HEAD',
        headers: agentHeaders(token),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    const missing = await fetch(`${base}${path}/application/receipts/missing`, {
      headers: agentHeaders(token),
    });
    expect(await missing.json()).toBeNull();
    const absent = await fetch(`${base}${path}/operations/missing`, { headers: operatorHeaders });
    expect(absent.status).toBe(404);
    const invalid = await fetch(`${base}${path}/application/execute`, {
      method: 'POST',
      headers: { ...agentHeaders(token), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(invalid.status).toBe(400);
  } finally {
    await server.close();
  }
}, 10_000);

it('returns an in-flight status snapshot and replay without borrowing the executing ticket', async () => {
  const entered = deferred();
  const release = deferred();
  const { server, state } = await buildApplicationServer(undefined, async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    const { path, token } = await bindAndDelegate(server);
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    const options = {
      method: 'POST',
      headers: { ...agentHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'add',
        input: 1,
        operationId: 'in-flight',
        expectedVersion: 0,
      }),
    };
    const original = fetch(`${base}${path}/application/execute`, options);
    await entered.promise;
    let snapshot: unknown;
    try {
      const status = await fetch(`${base}${path}/operations/in-flight`, {
        headers: operatorHeaders,
      });
      snapshot = await status.json();
      expect(snapshot).toMatchObject({ operationId: 'in-flight', status: 'in_flight' });
      const replay = await fetch(`${base}${path}/application/execute`, options);
      expect(await replay.json()).toEqual({ replay: true, operation: snapshot });
      expect(state.total).toBe(0);
      const control = await server.inject({ url: `${path}/control`, headers: operatorHeaders });
      expect(control.json().busy).toBe(true);
    } finally {
      release.resolve();
      await original;
    }
    expect(snapshot).toMatchObject({ status: 'in_flight' });
    expect(state.total).toBe(1);
  } finally {
    release.resolve();
    await server.close();
  }
}, 10_000);

it.each([200, 400])(
  'refuses unguarded success while preserving static pre-publication errors (%s)',
  async (status) => {
    const server = Fastify();
    const publication = createHttpPublication();
    server.get(
      '/missing-publication',
      { onSend: publication.onSend, onError: publication.onError },
      async (_request, reply) => reply.code(status).send({ value: 'must-not-escape-on-success' })
    );
    try {
      const base = await server.listen({ host: '127.0.0.1', port: 0 });
      const response = fetch(`${base}/missing-publication`);
      if (status === 200) await expect(response).rejects.toThrow();
      else expect((await response).status).toBe(400);
    } finally {
      await server.close();
    }
  },
  10_000
);

it('terminates a successful response callback that forgot to publish instead of awaiting an unsent reply', async () => {
  const server = Fastify();
  const publication = createHttpPublication();
  server.get(
    '/forgotten-publication',
    { onSend: publication.onSend, onError: publication.onError },
    async (request, reply) => publication.respond(request, reply, async () => undefined)
  );
  try {
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    const signal = AbortSignal.timeout(2000);
    await expect(fetch(`${base}/forgotten-publication`, { signal })).rejects.toThrow();
    expect(signal.aborted).toBe(false);
  } finally {
    await server.close();
  }
}, 10_000);
