import type { NativeFormEvidence } from '@agentbrowser/engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

const operator = { actor: 'operator' as const, tenant: 'owner' };
const documentId = '00000000-0000-4000-8000-000000000001';

const evidence = (): NativeFormEvidence => ({
  url: 'https://jobs.example.test/apply',
  documentId,
  form: {
    nodeId: `${documentId}:1`,
    id: 'application',
    name: 'application',
    action: 'https://jobs.example.test/submit',
    method: 'post',
  },
  controls: [
    {
      nodeId: `${documentId}:2`,
      blockId: null,
      id: 'full-name',
      name: 'fullName',
      tag: 'input',
      type: 'text',
      value: 'Synthetic Person',
      disabled: false,
      required: true,
      visible: true,
    },
  ],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}

async function fixture(
  capture?: (options?: { signal?: AbortSignal }) => Promise<NativeFormEvidence>
) {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  const { sessionId } = await service.createSession({
    tenantId: operator.tenant,
    controlMode: 'delegated',
  });
  const page = await service.authority.run(sessionId, operator, {}, () =>
    service.createPage(sessionId)
  );
  if ('replay' in page) throw new Error('Unexpected replay');
  const raw = engine.getFakePage(engine.getSessionIds()[0] ?? '', page.pageId);
  if (!raw) throw new Error('Missing fake page');
  if (capture !== undefined) raw.captureNativeForm = capture;
  return { service, sessionId, pageId: page.pageId, raw };
}

it('reads detached bounded native-form evidence within one admission without dispatch', async () => {
  const capture = vi.fn(async () => evidence());
  const f = await fixture(capture);
  try {
    await f.service.authority.run(f.sessionId, operator, {}, async () => {
      const reader = f.service.prepareNativeFormReadInScope(f.sessionId, f.pageId);
      expect(reader.identity).toEqual({
        sessionId: f.sessionId,
        pageId: f.pageId,
        sessionIncarnation: f.service.authority.sessionIncarnation(f.sessionId),
      });
      expect(Object.isFrozen(reader.identity)).toBe(true);
      expect(Object.isFrozen(reader)).toBe(true);
      (reader.assertAuthority as (ignored?: string) => void)('attacker-selected-session');
      const first = await reader.read();
      expect(first).toEqual(evidence());
      const firstControl = first.controls[0];
      if (!firstControl) throw new Error('Missing detached control');
      firstControl.value = 'Caller mutation';
      expect((await reader.read()).controls[0]?.value).toBe('Synthetic Person');
      expect(f.service.authority.didDispatchInScope(f.sessionId)).toBe(false);
    });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
  } finally {
    await f.service.shutdown();
  }
});

it('fails unsupported and pre-aborted reads before calling the engine', async () => {
  const unsupported = await fixture();
  try {
    await unsupported.service.authority.run(unsupported.sessionId, operator, {}, async () => {
      expect(() =>
        unsupported.service.prepareNativeFormReadInScope(unsupported.sessionId, unsupported.pageId)
      ).toThrow(/unavailable/iu);
    });
  } finally {
    await unsupported.service.shutdown();
  }

  const capture = vi.fn(async () => evidence());
  const f = await fixture(capture);
  try {
    await f.service.authority.run(f.sessionId, operator, {}, async () => {
      const reader = f.service.prepareNativeFormReadInScope(f.sessionId, f.pageId);
      const stop = new AbortController();
      stop.abort();
      await expect(reader.read(stop.signal)).rejects.toThrow(/cancel/iu);
      expect(capture).not.toHaveBeenCalled();
      expect(await reader.read()).toEqual(evidence());
    });
  } finally {
    await f.service.shutdown();
  }
});

it('sanitizes capture-method access and preserves authority changes caused by accessors', async () => {
  const unavailable = await fixture();
  Object.defineProperty(unavailable.raw, 'captureNativeForm', {
    configurable: true,
    get() {
      throw new Error('PRIVATE method accessor');
    },
  });
  try {
    await unavailable.service.authority.run(unavailable.sessionId, operator, {}, async () => {
      expect(() =>
        unavailable.service.prepareNativeFormReadInScope(unavailable.sessionId, unavailable.pageId)
      ).toThrow('Native form evidence capture is unavailable.');
    });
  } finally {
    await unavailable.service.shutdown();
  }

  const revoked = await fixture();
  Object.defineProperty(revoked.raw, 'captureNativeForm', {
    configurable: true,
    get() {
      revoked.service.authority.takeover(revoked.sessionId);
      throw new Error('PRIVATE method accessor');
    },
  });
  try {
    await expect(
      revoked.service.authority.run(revoked.sessionId, operator, {}, async () => {
        revoked.service.prepareNativeFormReadInScope(revoked.sessionId, revoked.pageId);
      })
    ).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  } finally {
    await revoked.service.shutdown();
  }
});

it('pins the captured engine method and receiver against later method replacement', async () => {
  const original = vi.fn(async function (this: { id: string }) {
    expect(this.id).toBeTruthy();
    return evidence();
  });
  const replacement = vi.fn(async () => ({ ...evidence(), documentId: 'replacement' }));
  const f = await fixture(original);
  try {
    await f.service.authority.run(f.sessionId, operator, {}, async () => {
      const reader = f.service.prepareNativeFormReadInScope(f.sessionId, f.pageId);
      f.raw.captureNativeForm = replacement;
      expect((await reader.read()).documentId).toBe(documentId);
    });
    expect(original).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
  } finally {
    await f.service.shutdown();
  }
});

it('does not let a prepared reader escape or revive in a new admission', async () => {
  const f = await fixture(async () => evidence());
  try {
    const reader = await f.service.authority.run(f.sessionId, operator, {}, async () =>
      f.service.prepareNativeFormReadInScope(f.sessionId, f.pageId)
    );
    await expect(reader.read()).rejects.toThrow();
    await f.service.authority.run(f.sessionId, operator, {}, async () => {
      expect(() => reader.assertAuthority()).toThrow();
      await expect(reader.read()).rejects.toThrow();
    });
  } finally {
    await f.service.shutdown();
  }
});

it('refuses replaced and closed pages before capture', async () => {
  const capture = vi.fn(async () => evidence());
  const f = await fixture(capture);
  try {
    await f.service.authority.run(f.sessionId, operator, {}, async () => {
      const reader = f.service.prepareNativeFormReadInScope(f.sessionId, f.pageId);
      const pages = (f.service as unknown as { pages: Map<string, unknown> }).pages;
      const original = pages.get(f.pageId);
      pages.set(f.pageId, { ...(original as object) });
      await expect(reader.read()).rejects.toThrow();
      pages.set(f.pageId, original);
      expect(capture).not.toHaveBeenCalled();
    });

    await f.service.authority.run(f.sessionId, operator, {}, async () => {
      const reader = f.service.prepareNativeFormReadInScope(f.sessionId, f.pageId);
      await f.service.closePage(f.sessionId, f.pageId);
      await expect(reader.read()).rejects.toThrow();
      expect(capture).not.toHaveBeenCalled();
    });
  } finally {
    await f.service.shutdown();
  }
});

it('refuses session owner replacement and keeps the original reader revoked', async () => {
  const capture = vi.fn(async () => evidence());
  const f = await fixture(capture);
  try {
    await expect(
      f.service.authority.run(f.sessionId, operator, {}, async () => {
        const reader = f.service.prepareNativeFormReadInScope(f.sessionId, f.pageId);
        f.service.authority.remove(f.sessionId);
        f.service.authority.register(f.sessionId, operator.tenant, new AbortController().signal);
        await expect(reader.read()).rejects.toThrow();
        expect(() => reader.assertAuthority()).toThrow();
      })
    ).rejects.toThrow();
    expect(capture).not.toHaveBeenCalled();
  } finally {
    await f.service.shutdown();
  }
});

it('tracks a late capture until settlement after the admission response closes', async () => {
  const captureResult = deferred<NativeFormEvidence>();
  const capture = vi.fn(() => captureResult.promise);
  const f = await fixture(capture);
  let pending!: Promise<NativeFormEvidence>;
  try {
    await f.service.authority.run(f.sessionId, operator, {}, async () => {
      pending = f.service.prepareNativeFormReadInScope(f.sessionId, f.pageId).read();
      void pending.catch(() => undefined);
    });
    await expect(
      f.service.authority.run(f.sessionId, operator, {}, async () => undefined)
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    captureResult.resolve(evidence());
    await expect(pending).rejects.toThrow();
    await expect.poll(() => f.service.authority.get(f.sessionId)?.view().busy).toBe(false);
    await expect(
      f.service.authority.run(f.sessionId, operator, {}, async () => 'fresh')
    ).resolves.toBe('fresh');
  } finally {
    captureResult.resolve(evidence());
    await f.service.shutdown();
  }
});

it('withholds a late capture result after takeover', async () => {
  const captureResult = deferred<NativeFormEvidence>();
  const capture = vi.fn(() => captureResult.promise);
  const f = await fixture(capture);
  try {
    const running = f.service.authority.run(f.sessionId, operator, {}, async () =>
      f.service.prepareNativeFormReadInScope(f.sessionId, f.pageId).read()
    );
    await expect.poll(() => capture).toHaveBeenCalledOnce();
    f.service.authority.takeover(f.sessionId);
    captureResult.resolve(evidence());
    await expect(running).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  } finally {
    captureResult.resolve(evidence());
    await f.service.shutdown();
  }
});

it('propagates caller cancellation to capture without permanently revoking the reader', async () => {
  const capture = vi.fn(
    ({ signal }: { signal?: AbortSignal } = {}) =>
      new Promise<NativeFormEvidence>((resolve, reject) => {
        if (signal?.aborted) reject(new Error('PRIVATE pre-abort'));
        else
          signal?.addEventListener('abort', () => reject(new Error('PRIVATE cancelled')), {
            once: true,
          });
        if (!signal) resolve(evidence());
      })
  );
  const f = await fixture(capture);
  try {
    await f.service.authority.run(f.sessionId, operator, {}, async () => {
      const reader = f.service.prepareNativeFormReadInScope(f.sessionId, f.pageId);
      const stop = new AbortController();
      const cancelled = reader.read(stop.signal);
      stop.abort();
      await expect(cancelled).rejects.toThrow(/cancel/iu);
      expect(capture).toHaveBeenCalledOnce();
      capture.mockImplementationOnce(async () => evidence());
      await expect(reader.read()).resolves.toEqual(evidence());
    });
  } finally {
    await f.service.shutdown();
  }
});

it.each([
  ['null', null],
  ['primitive', 3],
  ['missing controls', { ...evidence(), controls: undefined }],
  ['unknown root key', { ...evidence(), unknown: true }],
  ['unknown form key', { ...evidence(), form: { ...evidence().form, unknown: true } }],
  ['empty controls', { ...evidence(), controls: [] }],
  ['malformed control', { ...evidence(), controls: [{ tag: 'input' }] }],
  [
    'wrong control variant',
    {
      ...evidence(),
      controls: [{ ...evidence().controls[0], tag: 'select', type: 'select-one' }],
    },
  ],
  [
    'unknown control key',
    { ...evidence(), controls: [{ ...evidence().controls[0], unknown: true }] },
  ],
  [
    'malformed selected file',
    {
      ...evidence(),
      controls: [
        {
          ...evidence().controls[0],
          type: 'file',
          value: '',
          files: [{ name: 'candidate.pdf', type: 'application/pdf', size: 1 }],
        },
      ],
    },
  ],
])('rejects structurally invalid native evidence: %s', async (_name, value) => {
  const f = await fixture(async () => value as NativeFormEvidence);
  try {
    await f.service.authority.run(f.sessionId, operator, {}, async () => {
      const reader = f.service.prepareNativeFormReadInScope(f.sessionId, f.pageId);
      await expect(reader.read()).rejects.toThrow(/invalid data/iu);
    });
  } finally {
    await f.service.shutdown();
  }
});

it('sanitizes capture and malformed-output failures while preserving revocation', async () => {
  const cases: Array<() => unknown> = [
    () => Promise.reject(new Error('PRIVATE callback cause')),
    () => {
      const value = evidence();
      Object.defineProperty(value, 'controls', {
        enumerable: true,
        get() {
          throw new Error('PRIVATE getter cause');
        },
      });
      return Promise.resolve(value);
    },
    () => Promise.resolve({ ...evidence(), controls: ['x'.repeat(70_000)] }),
    () => Promise.resolve(new Date() as unknown as NativeFormEvidence),
  ];
  for (const make of cases) {
    const f = await fixture(make as () => Promise<NativeFormEvidence>);
    try {
      await f.service.authority.run(f.sessionId, operator, {}, async () => {
        const reader = f.service.prepareNativeFormReadInScope(f.sessionId, f.pageId);
        const error = await reader.read().catch((caught) => caught as Error);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).not.toContain('PRIVATE');
        expect(error.message).toMatch(/capture failed|invalid data|evidence unavailable/iu);
      });
    } finally {
      await f.service.shutdown();
    }
  }

  let service!: AgentBrowserService;
  let sessionId = '';
  const revoking = await fixture(
    async () =>
      new Proxy(evidence(), {
        ownKeys() {
          service.authority.takeover(sessionId);
          throw new Error('PRIVATE proxy cause');
        },
      })
  );
  service = revoking.service;
  sessionId = revoking.sessionId;
  try {
    await expect(
      service.authority.run(sessionId, operator, {}, async () => {
        const reader = service.prepareNativeFormReadInScope(sessionId, revoking.pageId);
        await reader.read();
      })
    ).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  } finally {
    await service.shutdown();
  }
});
