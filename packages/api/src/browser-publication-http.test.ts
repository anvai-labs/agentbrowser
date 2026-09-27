import { createHash } from 'node:crypto';
import { setImmediate as settlePublication } from 'node:timers/promises';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { AgentBrowserService } from './service.js';

const operator = { authorization: 'Bearer owner' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const fixture = () =>
  buildServer({
    engine: new FakeEngine(),
    apiKeys: new Map([[createHash('sha256').update('owner').digest('hex'), 'owner']]),
  });
async function create(server: Awaited<ReturnType<typeof fixture>>) {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: operator,
    payload: { controlMode: 'delegated' },
  });
  expect(response.statusCode).toBe(201);
  return `/v1/sessions/${response.json().sessionId}`;
}

it('finalizes browser execution before HTTP output while retaining exclusion through delivery', async () => {
  const server = await fixture();
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
    const path = await create(server);
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    const headers = { ...operator, 'x-agentbrowser-operation-id': 'create-page' };
    const pending = fetch(`${base}${path}/pages`, {
      method: 'POST',
      headers: { ...headers, 'x-hold-publication': 'yes' },
    });
    await entered.promise;
    try {
      const record = await server.inject({
        url: `${path}/operations/create-page`,
        headers: operator,
      });
      expect(record.json()).toMatchObject({ status: 'completed', dispatched: true });
      const replay = await fetch(`${base}${path}/pages`, { method: 'POST', headers });
      expect(await replay.json()).toMatchObject({
        replay: true,
        operation: { status: 'completed', dispatched: true },
      });
      const control = await server.inject({ url: `${path}/control`, headers: operator });
      expect(control.json().busy).toBe(true);
    } finally {
      release.resolve();
      expect((await pending).status).toBe(201);
    }
    await settlePublication();
    const pages = await server.inject({ url: `${path}/pages`, headers: operator });
    expect(pages.json().pages).toHaveLength(1);
  } finally {
    release.resolve();
    await server.close();
  }
}, 10_000);

it('terminates a browser response revoked by a late HTTP hook without rewriting completed execution', async () => {
  const server = await fixture();
  server.addHook('onSend', async (request, _reply, payload) => {
    if (request.headers['x-revoke-publication']) {
      const path = request.url.slice(0, request.url.lastIndexOf('/'));
      const revoked = await server.inject({
        method: 'POST',
        url: `${path}/control/takeover`,
        headers: operator,
      });
      expect(revoked.statusCode).toBe(200);
    }
    return payload;
  });
  try {
    const path = await create(server);
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    await expect(
      fetch(`${base}${path}/pages`, {
        method: 'POST',
        headers: {
          ...operator,
          'x-agentbrowser-operation-id': 'revoked-page',
          'x-revoke-publication': 'yes',
        },
      })
    ).rejects.toThrow();
    const record = await server.inject({
      url: `${path}/operations/revoked-page`,
      headers: operator,
    });
    expect(record.json()).toMatchObject({ status: 'completed', dispatched: true });
  } finally {
    await server.close();
  }
}, 10_000);

it.each(['disconnect', 'deadline'] as const)(
  'revokes %s browser publication before a late hook can send',
  async (cause) => {
    const server = await fixture();
    const entered = deferred();
    const release = deferred();
    const late = deferred();
    let raw: import('node:http').ServerResponse | undefined;
    server.addHook('onSend', async (request, reply, payload) => {
      if (request.headers['x-hold-publication']) {
        raw = reply.raw;
        entered.resolve();
        await release.promise;
        late.resolve();
      }
      return payload;
    });
    try {
      const path = await create(server);
      const base = await server.listen({ host: '127.0.0.1', port: 0 });
      const abort = new AbortController();
      const response = fetch(`${base}${path}/pages`, {
        method: 'POST',
        signal: abort.signal,
        headers: { ...operator, 'x-agentbrowser-operation-id': cause, 'x-hold-publication': 'yes' },
      });
      const refused = expect(response).rejects.toThrow();
      await entered.promise;
      if (cause === 'disconnect') abort.abort();
      await refused;
      await expect
        .poll(
          async () =>
            (await server.inject({ url: `${path}/control`, headers: operator })).json().busy
        )
        .toBe(false);
      expect(
        (await server.inject({ url: `${path}/operations/${cause}`, headers: operator })).json()
      ).toMatchObject({ status: 'completed', dispatched: true });
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

it.each([false, true])(
  'preserves browser body, status, headers, HEAD and static errors with controlled=%s',
  async (controlled) => {
    const server = await fixture();
    try {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: operator,
        payload: controlled ? { controlMode: 'delegated' } : {},
      });
      expect(created.statusCode).toBe(201);
      const path = `/v1/sessions/${created.json().sessionId}`;
      const base = await server.listen({ host: '127.0.0.1', port: 0 });
      const page = await fetch(`${base}${path}/pages`, {
        method: 'POST',
        headers: { ...operator, 'x-agentbrowser-operation-id': 'page' },
      });
      expect(page.status).toBe(201);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.headers.get('x-content-type-options')).toBe('nosniff');
      const pageId = ((await page.json()) as { pageId: string }).pageId;
      const head = await fetch(`${base}${path}/pages/${pageId}`, {
        method: 'HEAD',
        headers: operator,
      });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      const invalid = await fetch(`${base}${path}/pages/${pageId}/navigate`, {
        method: 'POST',
        headers: {
          ...operator,
          'content-type': 'application/json',
          'x-agentbrowser-operation-id': 'invalid',
        },
        body: '{}',
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        error: { code: 'INVALID_REQUEST', retryable: false },
      });
      if (controlled)
        expect(
          (await server.inject({ url: `${path}/operations/invalid`, headers: operator })).json()
        ).toMatchObject({ status: 'failed', dispatched: false });
      const missing = await fetch(`${base}${path}/pages/missing`, { headers: operator });
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  }
);

it('never downgrades a controlled response to legacy output after its authority is removed', async () => {
  const server = await fixture();
  let service: AgentBrowserService | undefined;
  const createSession = AgentBrowserService.prototype.createSession;
  const capture = vi
    .spyOn(AgentBrowserService.prototype, 'createSession')
    .mockImplementation(function (this: AgentBrowserService, ...args) {
      service = this;
      return createSession.apply(this, args);
    });
  try {
    const path = await create(server);
    if (!service) throw new Error('Missing service');
    service.authority.remove(path.slice(path.lastIndexOf('/') + 1));
    const response = await server.inject({ url: path, headers: operator });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONTROL_REVOKED' } });
    expect(response.body).not.toContain('createdAt');
  } finally {
    capture.mockRestore();
    await server.close();
  }
});
