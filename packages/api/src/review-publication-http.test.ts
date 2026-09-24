import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as settlePublication } from 'node:timers/promises';
import { SecretManager } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { type ServerOptions, buildServer } from './server.js';
import { AgentBrowserService } from './service.js';
import { createApplicationDraft } from './test-support/application-draft.js';

const headers = { authorization: 'Bearer owner', 'content-type': 'application/json' };
async function fixture() {
  const owner = createApplicationDraft({ id: 'review-http' });
  owner.update(0, { fullName: 'Synthetic Person' });
  let applicationAllowed = true;
  let service: AgentBrowserService | undefined;
  const engine = new FakeEngine();
  let permitted = true;
  let generation = 1;
  const secrets = new SecretManager();
  const collect = vi.fn(async () => ({ application: owner.read(), document: 'fixed-document' }));
  const source = { ownerId: 'http-evidence', contract: { id: 'http-review', version: '1' } };
  const provider = vi.fn<NonNullable<ServerOptions['evidenceReviewProvider']>>((routing) => ({
    action: {
      type: 'application-submit',
      intent: 'submit',
      tenant: routing.identity.tenant,
      sessionId: routing.identity.sessionId,
      sessionIncarnation: routing.identity.sessionIncarnation,
      ...routing.application,
      expectedVersion: owner.read().version,
      input: { intent: 'submit', expected: owner.read() },
    },
    source: {
      ...source,
      permission: { generation, currentGeneration: () => generation },
      assertAuthorized() {
        if (!permitted) throw new Error('private source denial');
      },
      collect,
    },
  }));
  const server = await buildServer({
    engine,
    secretManager: secrets,
    apiKeys: new Map([[createHash('sha256').update('owner').digest('hex'), 'owner']]),
    applicationAdapters: [
      {
        ...owner.adapter,
        authorize: (scope) => applicationAllowed && owner.adapter.authorize(scope),
        operations: { ...owner.adapter.operations, submit: owner.submissionOperation },
      },
    ],
    evidenceReviewProvider: provider,
  });
  const setup = async () => {
    const create = AgentBrowserService.prototype.createSession;
    const capture = vi
      .spyOn(AgentBrowserService.prototype, 'createSession')
      .mockImplementation(function (this: AgentBrowserService, ...args) {
        service = this;
        return create.apply(this, args);
      });
    const created = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: { controlMode: 'delegated', policy: { approval: { review: 'operator' } } },
    });
    capture.mockRestore();
    expect(created.statusCode).toBe(201);
    const path = `/v1/sessions/${created.json().sessionId}`;
    const bound = await server.inject({
      method: 'PUT',
      url: `${path}/application`,
      headers,
      payload: { adapter: owner.adapter.id, resource: 'review-http' },
    });
    expect(bound.statusCode).toBe(200);
    const page = await server.inject({
      method: 'POST',
      url: `${path}/pages`,
      headers: { ...headers, 'x-agentbrowser-operation-id': 'page' },
    });
    expect(page.statusCode).toBe(201);
    await settlePublication();
    const pageId = page.json().pageId;
    const raw = engine.getFakePage(engine.getSessionIds()[0] ?? '', pageId);
    assert(raw);
    raw.captureNativeForm = vi.fn(async () => {
      throw new Error('Unexpected native read');
    });
    return {
      path,
      pageId,
      body: {
        pageId,
        source,
        request: {
          operation: 'submit',
          operationId: 'never-executed',
          expectedVersion: owner.read().version,
          input: { intent: 'submit', expected: owner.read() },
        },
      },
    };
  };
  return {
    server,
    setup,
    owner,
    engine,
    provider,
    collect,
    secrets,
    revoke(changed: string, pageId: string) {
      if (changed === 'source') {
        generation++;
        permitted = false;
      }
      if (changed === 'application') applicationAllowed = false;
      if (changed === 'page') {
        const pages = (service as unknown as { pages: Map<string, object> }).pages;
        pages.set(pageId, { ...pages.get(pageId) });
      }
      if (changed === 'secret') {
        const policy = new SecretManager({ 'vault://new-policy': 'Synthetic Person' });
        vi.spyOn(secrets, 'redactUntrusted').mockImplementation((value) =>
          policy.redactUntrusted(value)
        );
      }
    },
  };
}

it.each(
  (['generate', 'get', 'decide'] as const).flatMap((mode) =>
    ['source', 'application', 'page', 'secret'].map((changed) => ({ mode, changed }))
  )
)(
  'suppresses $mode review output after $changed revocation in the final HTTP hook without recollecting',
  async ({ mode, changed }) => {
    const f = await fixture();
    let armed = false;
    let calls = 0;
    let pageId = '';
    f.server.addHook('onSend', async (request, _reply, payload) => {
      if (armed && request.headers['x-revoke-review']) {
        calls = f.collect.mock.calls.length;
        f.revoke(changed, pageId);
        await Promise.resolve();
      }
      return payload;
    });
    try {
      const setup = await f.setup();
      const { path, body } = setup;
      pageId = setup.pageId;
      let tokenId: string | undefined;
      if (mode !== 'generate') {
        const token = await f.server.inject({
          method: 'POST',
          url: `${path}/application/reviews`,
          headers,
          payload: body,
        });
        expect(token.statusCode).toBe(200);
        tokenId = token.json().tokenId;
        await settlePublication();
      }
      const base = await f.server.listen({ host: '127.0.0.1', port: 0 });
      armed = true;
      const url =
        mode === 'generate' ? `${path}/application/reviews` : `${path}/approvals/${tokenId}`;
      await expect(
        fetch(`${base}${url}`, {
          method: mode === 'get' ? 'GET' : 'POST',
          headers: {
            ...headers,
            'x-revoke-review': 'yes',
            ...(mode === 'decide' ? { 'x-agentbrowser-operation-id': 'decide-once' } : {}),
          },
          ...(mode === 'get'
            ? {}
            : { body: JSON.stringify(mode === 'generate' ? body : { decision: 'approve' }) }),
        })
      ).rejects.toThrow();
      expect(f.collect.mock.calls.length).toBe(calls);
      expect(f.owner.submissionCount()).toBe(0);
      if (mode === 'generate') {
        const status = await f.server.inject({ url: `${path}/operations/never-executed`, headers });
        expect(status.statusCode).toBe(404);
      }
      if (mode === 'decide') {
        const status = await f.server.inject({ url: `${path}/operations/decide-once`, headers });
        expect(status.json()).toMatchObject({ status: 'completed', dispatched: false });
        const before = f.provider.mock.calls.length;
        const replay = await fetch(`${base}${url}`, {
          method: 'POST',
          headers: { ...headers, 'x-agentbrowser-operation-id': 'decide-once' },
          body: JSON.stringify({ decision: 'approve' }),
        });
        expect(await replay.json()).toMatchObject({
          replay: true,
          operation: { status: 'completed' },
        });
        expect(f.provider.mock.calls.length).toBe(before);
      }
    } finally {
      await f.server.close();
    }
  },
  10_000
);

it('keeps prepare-resume in review after serialization failure and does not run execution cleanup', async () => {
  const f = await fixture();
  f.server.addHook('preSerialization', async (request, _reply, payload) => {
    if (request.url.endsWith('/control/prepare-resume')) throw new Error('private serialization');
    return payload;
  });
  try {
    const { path } = await f.setup();
    const base = await f.server.listen({ host: '127.0.0.1', port: 0 });
    await expect(
      fetch(`${base}${path}/control/prepare-resume`, { method: 'POST', headers })
    ).rejects.toThrow();
    const state = await f.server.inject({ url: `${path}/control`, headers });
    expect(state.json()).toMatchObject({ state: 'RESUME_REVIEW', busy: false });
  } finally {
    await f.server.close();
  }
}, 10_000);

it('restores the captured prepare-resume owner when observation collection fails', async () => {
  const f = await fixture();
  const observe = vi.spyOn(AgentBrowserService.prototype, 'observe');
  try {
    const { path } = await f.setup();
    observe.mockRejectedValueOnce(new Error('private engine failure'));
    const failed = await f.server.inject({
      method: 'POST',
      url: `${path}/control/prepare-resume`,
      headers,
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('private');
    const state = await f.server.inject({ url: `${path}/control`, headers });
    expect(state.json()).toMatchObject({ state: 'HUMAN_ACTIVE', busy: false });
  } finally {
    observe.mockRestore();
    await f.server.close();
  }
});

it('does not take over a replacement owner after prepare-resume collection fails', async () => {
  const f = await fixture();
  const observe = vi.spyOn(AgentBrowserService.prototype, 'observe');
  let replacement: ReturnType<AgentBrowserService['authority']['get']>;
  try {
    const { path } = await f.setup();
    observe.mockImplementationOnce(async function (this: AgentBrowserService, sessionId) {
      this.authority.remove(sessionId);
      this.authority.register(sessionId, 'owner', new AbortController().signal);
      replacement = this.authority.get(sessionId);
      assert(replacement);
      replacement.prepareResume();
      throw new Error('private collection failure');
    });
    const failed = await f.server.inject({
      method: 'POST',
      url: `${path}/control/prepare-resume`,
      headers,
    });
    expect(failed.statusCode).toBe(500);
    assert(replacement);
    expect(replacement.view()).toMatchObject({ state: 'RESUME_REVIEW', busy: false });
  } finally {
    observe.mockRestore();
    await f.server.close();
  }
});

it('guards approval-required challenge details from an admitted action after late takeover', async () => {
  const f = await fixture();
  let path = '';
  f.server.addHook('onSend', async (request, _reply, payload) => {
    if (request.headers['x-revoke-challenge']) {
      await f.server.inject({ method: 'POST', url: `${path}/control/takeover`, headers });
    }
    return payload;
  });
  try {
    const setup = await f.setup();
    path = setup.path;
    const page = f.engine.getFakePage(f.engine.getSessionIds()[0] ?? '', setup.pageId);
    assert(page);
    page.setElements([{ role: 'button', name: 'Save setting', risk: 'transaction' }]);
    const observed = await f.server.inject({
      method: 'POST',
      url: `${path}/pages/${setup.pageId}/observe`,
      headers,
      payload: {},
    });
    await settlePublication();
    const ref = observed.json().elements[0].ref;
    const base = await f.server.listen({ host: '127.0.0.1', port: 0 });
    await expect(
      fetch(`${base}${path}/pages/${setup.pageId}/act`, {
        method: 'POST',
        headers: {
          ...headers,
          'x-agentbrowser-operation-id': 'challenge',
          'x-revoke-challenge': 'yes',
        },
        body: JSON.stringify({ action: 'click', target: { ref } }),
      })
    ).rejects.toThrow();
  } finally {
    await f.server.close();
  }
}, 10_000);
