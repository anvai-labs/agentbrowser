import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type EvidenceReviewSource, NATIVE_FORM_REVIEW_TYPE } from '@agentbrowser/control';
import { ApprovalGate, SecretManager } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import {
  AgentBrowserService,
  type ServiceDependencies,
  type ServiceEvidenceReviewRequest,
} from './service.js';

const operator = { actor: 'operator' as const, tenant: 'owner' };
const signal = () => new AbortController().signal;
const services: AgentBrowserService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
});

async function fixture(
  options: {
    reviewed?: boolean;
    secret?: string;
    publicReview?: boolean;
    evidenceReviewProvider?: ServiceDependencies['evidenceReviewProvider'];
  } = {}
) {
  const engine = new FakeEngine();
  const gate = new ApprovalGate();
  let generation = 1;
  let ownerId = randomUUID();
  let permitted = true;
  let witness: unknown = {
    application: { fields: { name: 'Synthetic person' }, version: 1 },
    page: { documentId: 'document' },
  };
  const action = { intent: 'draft', destination: 'https://example.test/apply', job: 'synthetic' };
  const collect = vi.fn(async () => structuredClone(witness));
  const source = (): EvidenceReviewSource => ({
    ownerId,
    contract: { id: 'synthetic-native-draft', version: '1' },
    permission: { generation, currentGeneration: () => generation },
    assertAuthorized() {
      if (!permitted) throw new Error('PRIVATE permission failure');
    },
    collect,
  });
  const provider = vi.fn(
    options.evidenceReviewProvider ??
      ((_request: ServiceEvidenceReviewRequest) =>
        options.publicReview ? { action, source: source() } : undefined)
  );
  const service = new AgentBrowserService({
    engine,
    approvalGate: gate,
    secretManager: new SecretManager(options.secret ? { 'vault://fixture': options.secret } : {}),
    ...(options.publicReview || options.evidenceReviewProvider
      ? { evidenceReviewProvider: provider }
      : {}),
  });
  services.push(service);
  const { sessionId } = await service.createSession({
    tenantId: 'owner',
    controlMode: 'delegated',
    ...(options.reviewed === false ? {} : { approval: { review: 'operator' as const } }),
  });
  const run = async <T>(read: () => Promise<T>): Promise<T> => {
    const result = await service.authority.run(sessionId, operator, {}, read);
    if (result && typeof result === 'object' && 'replay' in result)
      throw new Error('Unexpected replay');
    return result as T;
  };
  const { pageId } = await run(() => service.createPage(sessionId));
  const raw = engine.getFakePage(engine.getSessionIds()[0] ?? '', pageId);
  assert(raw);
  // Preparing the ownership fence must not perform a redundant browser read.
  raw.captureNativeForm = vi.fn(async () => {
    throw new Error('Unexpected native read');
  });
  const dispatch = vi.spyOn(raw, 'act');
  const prepare = (
    overrides: Partial<{ action: Record<string, unknown>; source: EvidenceReviewSource }> = {}
  ) =>
    service.prepareEvidenceReviewInScope(sessionId, pageId, {
      action,
      source: source(),
      ...overrides,
    });
  return {
    service,
    gate,
    engine,
    run,
    sessionId,
    pageId,
    raw,
    dispatch,
    action,
    collect,
    source,
    provider,
    prepare,
    setWitness(value: unknown) {
      witness = value;
    },
    setPermission(value: boolean) {
      permitted = value;
      generation++;
    },
    replaceOwner() {
      ownerId = randomUUID();
    },
  };
}

it('reviews complete evidence across separate admissions with single consumption and no dispatch', async () => {
  const f = await fixture();
  const token = await f.run(() => f.prepare().generate(signal()));
  expect(token.status).toBe('pending');
  expect(token.action.parameters).toMatchObject({
    action: f.action,
    witness: { application: { fields: { name: 'Synthetic person' } } },
  });
  expect((await f.run(() => f.prepare().get(token.tokenId, signal())))?.status).toBe('pending');
  expect((await f.run(() => f.prepare().decide(token.tokenId, 'approve', signal())))?.status).toBe(
    'approved'
  );
  expect(await f.run(() => f.prepare().consume(token.tokenId, signal()))).toBe(true);
  expect(await f.run(() => f.prepare().consume(token.tokenId, signal()))).toBe(false);
  expect(f.raw.captureNativeForm).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it.each(['symbol', 'hidden'])(
  'refuses %s action properties rather than dropping them before review',
  async (kind) => {
    const f = await fixture();
    const action = { ...f.action };
    Object.defineProperty(action, kind === 'symbol' ? Symbol('private') : 'hidden', {
      value: 'unreviewed',
      enumerable: kind === 'symbol',
    });
    await expect(f.run(() => f.prepare({ action }).generate(signal()))).rejects.toThrow(
      'Evidence review unavailable'
    );
    expect(f.collect).not.toHaveBeenCalled();
  }
);

it('refuses reserved tokens through public inspection and decision surfaces', async () => {
  const f = await fixture();
  const token = await f.run(() => f.prepare().generate(signal()));
  await expect(
    f.run(() => f.service.getApproval(f.sessionId, token.tokenId))
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    f.run(() => f.service.decideApproval(f.sessionId, token.tokenId, 'approve'))
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await f.run(() => f.prepare().get(token.tokenId, signal())))?.status).toBe('pending');
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('resolves configured public inspection and decision without exposing private data to provider', async () => {
  const f = await fixture({ publicReview: true });
  const token = await f.run(() => f.prepare().generate(signal()));
  const inspected = await f.run(() => f.service.getApproval(f.sessionId, token.tokenId));
  expect(inspected).toEqual(token);
  expect(f.provider).toHaveBeenCalledOnce();
  const request = f.provider.mock.calls[0]?.[0];
  expect(request).toEqual({
    identity: {
      tenant: 'owner',
      sessionId: f.sessionId,
      sessionIncarnation: expect.any(String),
      pageId: f.pageId,
    },
    source: {
      ownerId: expect.any(String),
      contract: { id: 'synthetic-native-draft', version: '1' },
    },
  });
  expect(Object.isFrozen(request)).toBe(true);
  expect(Object.isFrozen(request?.identity)).toBe(true);
  expect(Object.isFrozen(request?.source)).toBe(true);
  expect(JSON.stringify(request)).not.toContain('Synthetic person');
  expect(JSON.stringify(request)).not.toContain('permissionGeneration');

  const decided = await f.run(() =>
    f.service.decideApproval(f.sessionId, token.tokenId, 'approve')
  );
  expect(decided.status).toBe('approved');
  expect(f.provider).toHaveBeenCalledTimes(2);
  expect(f.raw.captureNativeForm).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('refuses revoked, regranted, or replaced source owners through public review', async () => {
  const f = await fixture({ publicReview: true });
  const token = await f.run(() => f.prepare().generate(signal()));
  f.setPermission(false);
  await expect(
    f.run(() => f.service.getApproval(f.sessionId, token.tokenId))
  ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Current approval is unavailable' });
  f.setPermission(true);
  await expect(
    f.run(() => f.service.getApproval(f.sessionId, token.tokenId))
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  f.replaceOwner();
  await expect(
    f.run(() => f.service.decideApproval(f.sessionId, token.tokenId, 'approve'))
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(f.dispatch).not.toHaveBeenCalled();
});

it.each(['promise', 'thenable', 'getter'] as const)(
  'fails closed on a %s provider result with a static public error',
  async (mode) => {
    const privateGetter = vi.fn(() => ({ intent: 'private' }));
    const f = await fixture({
      evidenceReviewProvider: (() => {
        if (mode === 'promise') return Promise.reject(new Error('PRIVATE promise')) as never;
        if (mode === 'thenable')
          return {
            // biome-ignore lint/suspicious/noThenProperty: reject a misconfigured provider thenable
            then: (_resolve: unknown, reject: (error: Error) => void) =>
              reject(new Error('PRIVATE thenable')),
          } as never;
        return Object.defineProperty({ source: f?.source?.() }, 'action', {
          enumerable: true,
          get: privateGetter,
        }) as never;
      }) as never,
    });
    const token = await f.run(() => f.prepare().generate(signal()));
    await expect(
      f.run(() => f.service.getApproval(f.sessionId, token.tokenId))
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Current approval is unavailable' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (mode === 'getter') expect(privateGetter).not.toHaveBeenCalled();
  }
);

it('captures the provider at construction and refuses reentrant authority takeover', async () => {
  const state: { service?: AgentBrowserService; sessionId: string } = { sessionId: '' };
  const original = vi.fn(() => {
    state.service?.authority.takeover(state.sessionId);
    return undefined;
  });
  const engine = new FakeEngine();
  const deps: ServiceDependencies = {
    engine,
    evidenceReviewProvider: original,
  };
  const service = new AgentBrowserService(deps);
  state.service = service;
  services.push(service);
  deps.evidenceReviewProvider = vi.fn(() => undefined);
  const created = await service.createSession({
    tenantId: 'owner',
    controlMode: 'delegated',
    approval: { review: 'operator' },
  });
  const sessionId = created.sessionId;
  state.sessionId = sessionId;
  const run = async <T>(read: () => Promise<T>): Promise<T> => {
    const result = await service?.authority.run(sessionId, operator, {}, read);
    return result as T;
  };
  const { pageId } = await run(() => service?.createPage(sessionId) as Promise<{ pageId: string }>);
  const raw = engine.getFakePage(engine.getSessionIds()[0] ?? '', pageId);
  assert(raw);
  raw.captureNativeForm = vi.fn(async () => {
    throw new Error('Unexpected native read');
  });
  const token = await run(
    () =>
      service
        ?.prepareEvidenceReviewInScope(sessionId, pageId, {
          action: { intent: 'draft' },
          source: {
            ownerId: 'owner-a',
            contract: { id: 'synthetic-native-draft', version: '1' },
            permission: { generation: 1, currentGeneration: () => 1 },
            assertAuthorized() {},
            collect: async () => ({ complete: true }),
          },
        })
        .generate(signal()) as never
  );
  await expect(
    run(() => service?.getApproval(sessionId, token.tokenId) as never)
  ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Current approval is unavailable' });
  expect(original).toHaveBeenCalledOnce();
  expect(deps.evidenceReviewProvider).not.toHaveBeenCalled();
});

it('rechecks the exact page pin after provider replacement reentry', async () => {
  const holder: { value?: Awaited<ReturnType<typeof fixture>> } = {};
  const f = await fixture({
    evidenceReviewProvider: (request) => {
      const fixture = holder.value;
      assert(fixture);
      const pages = (
        fixture.service as unknown as {
          pages: Map<string, { sessionId: string; enginePage: unknown }>;
        }
      ).pages;
      const current = pages.get(request.identity.pageId);
      assert(current);
      pages.set(request.identity.pageId, { ...current });
      return { action: fixture.action, source: fixture.source() };
    },
  });
  holder.value = f;
  const token = await f.run(() => f.prepare().generate(signal()));
  await expect(
    f.run(() => f.service.getApproval(f.sessionId, token.tokenId))
  ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Current approval is unavailable' });
  expect(f.dispatch).not.toHaveBeenCalled();
});

it.each(['extra', 'symbol'] as const)(
  'rejects a provider result with an unexpected %s property',
  async (kind) => {
    const holder: { value?: Awaited<ReturnType<typeof fixture>> } = {};
    const f = await fixture({
      evidenceReviewProvider: (() => {
        const fixture = holder.value;
        assert(fixture);
        const result: Record<PropertyKey, unknown> = {
          action: fixture.action,
          source: fixture.source(),
        };
        result[kind === 'extra' ? 'extra' : Symbol('private')] = 'PRIVATE';
        return result as never;
      }) as never,
    });
    holder.value = f;
    const token = await f.run(() => f.prepare().generate(signal()));
    await expect(
      f.run(() => f.service.getApproval(f.sessionId, token.tokenId))
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Current approval is unavailable' });
  }
);

it.each(['get', 'decide'] as const)(
  'rechecks legacy authority after the resolve await before %s disclosure or mutation',
  async (operation) => {
    const f = await fixture();
    let binding!: ReturnType<typeof f.service.authority.reviewBindingInScope>;
    const token = await f.run(async () => {
      binding = f.service.authority.reviewBindingInScope(f.sessionId);
      return await f.gate.generateReviewedApproval(
        { sessionId: f.sessionId, action: { type: 'legacy.review', public: 'safe' } },
        binding
      );
    });
    const originalGet = f.gate.getReviewedApproval;
    f.gate.getReviewedApproval = async function (...args) {
      const view = await Reflect.apply(originalGet, this, args);
      queueMicrotask(() => queueMicrotask(() => f.service.authority.takeover(f.sessionId)));
      return view;
    };
    let disclosed: unknown;
    await expect(
      f.run(async () => {
        disclosed = await (operation === 'get'
          ? f.service.getApproval(f.sessionId, token.tokenId)
          : f.service.decideApproval(f.sessionId, token.tokenId, 'approve'));
      })
    ).rejects.toThrow();
    expect(disclosed).toBeUndefined();
    const stored = await Reflect.apply(originalGet, f.gate, [token.tokenId, binding]);
    expect(stored?.status).toBe('pending');
  }
);

it('refuses configured public disclosure and decision of registered secrets without mutation', async () => {
  const secret = 'PRIVATE-configured-review-secret';
  const f = await fixture({ publicReview: true, secret });
  const configuredSource = f.source();
  let binding!: ReturnType<typeof f.service.authority.reviewBindingInScope>;
  const token = await f.run(async () => {
    binding = f.service.authority.reviewBindingInScope(f.sessionId);
    return await f.gate.generateReviewedApproval(
      {
        sessionId: f.sessionId,
        action: {
          type: NATIVE_FORM_REVIEW_TYPE,
          pageId: f.pageId,
          parameters: {
            action: f.action,
            source: {
              ownerId: configuredSource.ownerId,
              contract: configuredSource.contract,
              permissionGeneration: configuredSource.permission.generation,
            },
            witness: { answer: secret },
          },
        },
      },
      binding
    );
  });
  await expect(
    f.run(() => f.service.getApproval(f.sessionId, token.tokenId))
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    f.run(() => f.service.decideApproval(f.sessionId, token.tokenId, 'approve'))
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await f.gate.getReviewedApproval(token.tokenId, binding))?.status).toBe('pending');
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('cannot use an approved internal witness token to authorize an ordinary browser action', async () => {
  const f = await fixture();
  const token = await f.run(() => f.prepare().generate(signal()));
  await f.run(() => f.prepare().decide(token.tokenId, 'approve', signal()));
  f.raw.setElements([{ role: 'button', name: 'Synthetic submit', risk: 'transaction' }]);
  const observed = await f.run(() => f.service.observe(f.sessionId, f.pageId, {}));
  const target = observed.elements[0];
  assert(target);
  await expect(
    f.run(() =>
      f.service.act(f.sessionId, f.pageId, {
        action: 'click',
        target: { ref: target.ref },
        approvalToken: token.tokenId,
      })
    )
  ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  expect(f.dispatch).not.toHaveBeenCalled();
  expect((await f.run(() => f.prepare().get(token.tokenId, signal())))?.status).toBe('approved');
});

it('requires operator-reviewed policy and refuses escaped or newly admitted handles', async () => {
  const legacy = await fixture({ reviewed: false });
  await expect(legacy.run(async () => legacy.prepare())).rejects.toThrow();
  const f = await fixture();
  const prepared = await f.run(async () => f.prepare());
  await expect(prepared.generate(signal())).rejects.toThrow();
  await expect(f.run(() => prepared.generate(signal()))).rejects.toThrow();
  expect(f.collect).not.toHaveBeenCalled();
});

it('refuses changed complete evidence without burning the previously approved token', async () => {
  const f = await fixture();
  const token = await f.run(() => f.prepare().generate(signal()));
  await f.run(() => f.prepare().decide(token.tokenId, 'approve', signal()));
  f.setWitness({
    application: { fields: { name: 'Changed in both app and UI' }, version: 2 },
    page: { documentId: 'document' },
  });
  expect(await f.run(() => f.prepare().consume(token.tokenId, signal()))).toBe(false);
  expect((await f.run(() => f.prepare().get(token.tokenId, signal())))?.status).toBe('approved');
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('revocation and regrant cannot revive old private reviews in a fresh admission', async () => {
  const f = await fixture();
  const token = await f.run(() => f.prepare().generate(signal()));
  await f.run(() => f.prepare().decide(token.tokenId, 'approve', signal()));
  f.setPermission(false);
  await expect(f.run(() => f.prepare().get(token.tokenId, signal()))).rejects.toThrow();
  f.setPermission(true);
  expect(await f.run(() => f.prepare().get(token.tokenId, signal()))).toBeUndefined();
  expect(await f.run(() => f.prepare().decide(token.tokenId, 'approve', signal()))).toBeUndefined();
  expect(await f.run(() => f.prepare().consume(token.tokenId, signal()))).toBe(false);
});

it.each(['value', 'key'])(
  'refuses registered secrets in evidence %s without private diagnostics',
  async (where) => {
    const secret = 'PRIVATE-fixture-credential';
    const f = await fixture({ secret });
    f.setWitness(where === 'key' ? { [secret]: 'data' } : { answer: secret });
    await expect(f.run(() => f.prepare().generate(signal()))).rejects.toThrow(
      'Evidence review unavailable'
    );
    expect(f.collect).toHaveBeenCalledOnce();
  }
);

it('pins intended action before asynchronous evidence collection', async () => {
  const f = await fixture();
  f.collect.mockImplementationOnce(async () => {
    f.action.intent = 'unreviewed caller replacement';
    return { complete: true };
  });
  const token = await f.run(() => f.prepare().generate(signal()));
  expect(token.action.parameters).toMatchObject({ action: { intent: 'draft' } });
});

it('rejects another page or changed action/source even with the same token ID', async () => {
  const f = await fixture();
  const token = await f.run(() => f.prepare().generate(signal()));
  expect(
    await f.run(() =>
      f.prepare({ action: { ...f.action, job: 'other' } }).get(token.tokenId, signal())
    )
  ).toBeUndefined();
  const changed = f.source();
  changed.contract = { id: 'other-contract', version: '1' };
  expect(
    await f.run(() => f.prepare({ source: changed }).decide(token.tokenId, 'approve', signal()))
  ).toBeUndefined();
  const { pageId } = await f.run(() => f.service.createPage(f.sessionId));
  const other = f.engine.getFakePage(f.engine.getSessionIds()[0] ?? '', pageId);
  assert(other);
  other.captureNativeForm = f.raw.captureNativeForm;
  expect(
    await f.run(() =>
      f.service
        .prepareEvidenceReviewInScope(f.sessionId, pageId, { action: f.action, source: f.source() })
        .get(token.tokenId, signal())
    )
  ).toBeUndefined();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('rechecks owner takeover during collection and never releases stale private evidence', async () => {
  const f = await fixture();
  f.collect.mockImplementationOnce(async () => {
    f.service.authority.takeover(f.sessionId);
    return { private: 'not releasable' };
  });
  await expect(f.run(() => f.prepare().generate(signal()))).rejects.toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('tracks the whole collector through admission drain, including work outside nested reads', async () => {
  const f = await fixture();
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.collect.mockImplementationOnce(async () => {
    await blocked;
    return {};
  });
  let result: Promise<unknown> | undefined;
  try {
    await f.run(async () => {
      result = f.prepare().generate(signal());
      void result.catch(() => {});
    });
    await expect(f.run(async () => true)).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    release();
    assert(result);
    await expect(result).rejects.toThrow();
    await expect
      .poll(async () => {
        try {
          return await f.run(async () => true);
        } catch {
          return false;
        }
      })
      .toBe(true);
  } finally {
    release();
  }
});
