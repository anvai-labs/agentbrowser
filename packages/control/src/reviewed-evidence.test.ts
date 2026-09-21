import { ApprovalGate, type ApprovalReviewBinding } from '@agentbrowser/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvidencePermission } from './outcome-runner.js';
import {
  type EvidenceReviewSource,
  NATIVE_FORM_REVIEW_TYPE,
  prepareEvidenceReview,
} from './reviewed-evidence.js';
import { prepareEvidencePermission } from './trusted-callback.js';

const context: ApprovalReviewBinding = Object.freeze({
  tenant: 'tenant-a',
  sessionId: 'session-a',
  sessionIncarnation: 'incarnation-a',
  epoch: 3,
  reviewVersion: 'native-form.v1',
});

const gates: ApprovalGate[] = [];
afterEach(async () => {
  await Promise.all(gates.splice(0).map((gate) => gate.shutdown()));
});

function fixture(
  options: {
    gate?: ApprovalGate;
    action?: Record<string, unknown>;
    pageId?: string;
    generation?: { value: number };
    currentGeneration?: () => number;
    collect?: EvidenceReviewSource['collect'];
    assertAuthority?: () => void;
    assertAuthorized?: EvidenceReviewSource['assertAuthorized'];
    assertDisclosureSafe?: (value: unknown) => void;
    trackRead?: <T>(read: () => Promise<T>) => Promise<T>;
    contract?: { id: string; version: string };
    ownerId?: string;
    lifecycleSignal?: AbortSignal;
    context?: ApprovalReviewBinding;
  } = {}
) {
  const gate = options.gate ?? new ApprovalGate({ tokenTtlMs: 1_000 });
  if (!gates.includes(gate)) gates.push(gate);
  const generation = options.generation ?? { value: 7 };
  const permission: EvidencePermission = {
    generation: generation.value,
    currentGeneration() {
      return options.currentGeneration?.() ?? generation.value;
    },
  };
  const source: EvidenceReviewSource = {
    ownerId: options.ownerId ?? 'owner-incarnation-a',
    contract: options.contract ?? { id: 'native-form.witness', version: '1.0.0' },
    permission,
    assertAuthorized: options.assertAuthorized ?? vi.fn(),
    collect: options.collect ?? vi.fn(async () => ({ documentId: 'doc-1', revision: 1 })),
  };
  const assertAuthority = options.assertAuthority ?? vi.fn();
  const assertDisclosureSafe = options.assertDisclosureSafe ?? vi.fn();
  const trackRead = options.trackRead ?? (async <T>(read: () => Promise<T>) => await read());
  const prepared = prepareEvidenceReview({
    gate,
    context: options.context ?? context,
    pageId: options.pageId ?? 'pg_1_page-1',
    action: options.action ?? { operation: 'submit', target: 'application' },
    source,
    assertAuthority,
    assertDisclosureSafe,
    trackRead,
    ...(options.lifecycleSignal ? { lifecycleSignal: options.lifecycleSignal } : {}),
  });
  return {
    gate,
    generation,
    permission,
    source,
    prepared,
    assertAuthority,
    assertDisclosureSafe,
    trackRead,
  };
}

describe('prepared evidence review', () => {
  it('stores one reserved reviewed action and atomically consumes approved current evidence', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const generated = await f.prepared.generate(signal);

    expect(generated).toMatchObject({
      status: 'pending',
      action: {
        type: NATIVE_FORM_REVIEW_TYPE,
        pageId: 'pg_1_page-1',
        parameters: {
          action: { operation: 'submit', target: 'application' },
          source: {
            ownerId: 'owner-incarnation-a',
            contract: { id: 'native-form.witness', version: '1.0.0' },
            permissionGeneration: 7,
          },
          witness: { documentId: 'doc-1', revision: 1 },
        },
      },
    });
    expect(await f.prepared.get(generated.tokenId, signal)).toEqual(generated);
    expect((await f.prepared.decide(generated.tokenId, 'approve', signal))?.status).toBe(
      'approved'
    );
    expect(await f.prepared.consume(generated.tokenId, signal)).toBe(true);
    expect(await f.prepared.consume(generated.tokenId, signal)).toBe(false);
    expect(f.source.collect).toHaveBeenCalledTimes(3);
    expect(f.gate.getTokenCount()).toBe(1);
  });

  it('captures action, context, contract, callbacks and receivers before collector await', async () => {
    let release!: (value: unknown) => void;
    const witness = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const action = { operation: 'submit', target: 'original' };
    const f = fixture({ action, collect: vi.fn(() => witness) });
    const originalCollect = f.source.collect;
    const pending = f.prepared.generate(new AbortController().signal);
    action.target = 'mutated';
    (f.source.contract as { id: string }).id = 'mutated';
    f.source.collect = vi.fn(async () => ({ private: 'replacement' })) as never;
    f.source.assertAuthorized = vi.fn(() => {
      throw new Error('replacement');
    }) as never;
    release({ documentId: 'doc-1' });

    const generated = await pending;
    expect(generated.action).toMatchObject({
      parameters: {
        action: { operation: 'submit', target: 'original' },
        source: { contract: { id: 'native-form.witness', version: '1.0.0' } },
      },
    });
    expect(originalCollect).toHaveBeenCalledOnce();
  });

  it('refuses a stale witness without burning the approved token', async () => {
    const witnesses = [{ revision: 1 }, { revision: 2 }, { revision: 1 }];
    const f = fixture({ collect: vi.fn(async () => witnesses.shift()) });
    const signal = new AbortController().signal;
    const token = await f.prepared.generate(signal);
    await f.prepared.decide(token.tokenId, 'approve', signal);
    expect(await f.prepared.consume(token.tokenId, signal)).toBe(false);
    expect(await f.prepared.consume(token.tokenId, signal)).toBe(true);
  });

  it.each([
    ['page', { pageId: 'pg_other' }],
    ['action', { action: { operation: 'submit', target: 'other' } }],
  ] as const)('does not disclose or decide a token with changed %s', async (_name, changed) => {
    const gate = new ApprovalGate();
    gates.push(gate);
    const owner = fixture({ gate });
    const token = await owner.prepared.generate(new AbortController().signal);
    const foreign = fixture({ gate, ...changed });
    expect(await foreign.prepared.get(token.tokenId, new AbortController().signal)).toBeUndefined();
    expect(
      await foreign.prepared.decide(token.tokenId, 'approve', new AbortController().signal)
    ).toBeUndefined();
    expect(foreign.assertDisclosureSafe).not.toHaveBeenCalled();
  });

  it('binds contract version and permission generation into the reviewed fingerprint', async () => {
    const gate = new ApprovalGate();
    gates.push(gate);
    const first = fixture({ gate });
    const token = await first.prepared.generate(new AbortController().signal);
    const changedVersion = fixture({
      gate,
      contract: { id: 'native-form.witness', version: '2.0.0' },
    });
    expect(
      await changedVersion.prepared.get(token.tokenId, new AbortController().signal)
    ).toBeUndefined();
    const changedGeneration = fixture({ gate, generation: { value: 8 } });
    expect(
      await changedGeneration.prepared.get(token.tokenId, new AbortController().signal)
    ).toBeUndefined();
    expect(
      await changedGeneration.prepared.consume(token.tokenId, new AbortController().signal)
    ).toBe(false);
  });

  it('refuses a different source owner with the same contract and generation before disclosure', async () => {
    const gate = new ApprovalGate();
    gates.push(gate);
    const first = fixture({ gate, ownerId: 'owner-incarnation-a' });
    const token = await first.prepared.generate(new AbortController().signal);
    const replacement = fixture({ gate, ownerId: 'owner-incarnation-b' });
    const signal = new AbortController().signal;
    expect(await replacement.prepared.get(token.tokenId, signal)).toBeUndefined();
    expect(await replacement.prepared.decide(token.tokenId, 'approve', signal)).toBeUndefined();
    expect(replacement.assertDisclosureSafe).not.toHaveBeenCalled();
  });

  it('permanently latches permission generation revocation including regrant', async () => {
    const f = fixture();
    f.generation.value = 8;
    await expect(f.prepared.generate(new AbortController().signal)).rejects.toThrow(
      'Evidence review unavailable'
    );
    f.generation.value = 7;
    await expect(f.prepared.generate(new AbortController().signal)).rejects.toThrow(
      'Evidence review unavailable'
    );
    expect(f.source.collect).not.toHaveBeenCalled();
  });

  it('latches source and collector-observed owner failures while cancellation alone stays reusable', async () => {
    let sourceValid = true;
    let reads = 0;
    const f = fixture({
      assertAuthorized: vi.fn(() => {
        if (!sourceValid) throw new Error('PRIVATE-SOURCE');
      }),
      collect: vi.fn(async () => {
        if (reads++ === 0) return { revision: 1 };
        sourceValid = false;
        throw new Error('PRIVATE-COLLECTOR');
      }),
    });
    const signal = new AbortController().signal;
    const token = await f.prepared.generate(signal);
    await f.prepared.decide(token.tokenId, 'approve', signal);
    await expect(f.prepared.consume(token.tokenId, signal)).rejects.toThrow(
      'Evidence review unavailable'
    );
    sourceValid = true;
    await expect(f.prepared.get(token.tokenId, signal)).rejects.toThrow(
      'Evidence review unavailable'
    );

    const reusable = fixture();
    const reusableToken = await reusable.prepared.generate(signal);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(reusable.prepared.get(reusableToken.tokenId, cancelled.signal)).rejects.toThrow(
      'Evidence review unavailable'
    );
    await expect(reusable.prepared.get(reusableToken.tokenId, signal)).resolves.toBeDefined();
  });

  it('permanently latches a transient source guard failure', async () => {
    let valid = true;
    const f = fixture({
      assertAuthorized: vi.fn(() => {
        if (!valid) throw new Error('PRIVATE-SOURCE');
      }),
    });
    valid = false;
    await expect(f.prepared.get('missing', new AbortController().signal)).rejects.toThrow(
      'Evidence review unavailable'
    );
    valid = true;
    await expect(f.prepared.get('missing', new AbortController().signal)).rejects.toThrow(
      'Evidence review unavailable'
    );
  });

  it('rechecks source authority after permission generation callback reentry', async () => {
    let attack = false;
    let armed = false;
    let sourceAllowed = true;
    const f = fixture({
      assertAuthorized: vi.fn(() => {
        if (!sourceAllowed) throw new Error('PRIVATE-SOURCE');
      }),
      currentGeneration: () => {
        if (armed) sourceAllowed = false;
        return 7;
      },
      assertDisclosureSafe: vi.fn(() => {
        if (attack) armed = true;
      }),
    });
    const signal = new AbortController().signal;
    const token = await f.prepared.generate(signal);
    attack = true;
    await expect(f.prepared.get(token.tokenId, signal)).rejects.toThrow(
      'Evidence review unavailable'
    );
    sourceAllowed = true;
    await expect(f.prepared.get(token.tokenId, signal)).rejects.toThrow(
      'Evidence review unavailable'
    );
  });

  it('fails closed on an asynchronous authority guard and consumes its rejection', async () => {
    const rejection = Promise.reject(new Error('PRIVATE-ASYNC-GUARD'));
    expect(() => fixture({ assertAuthorized: vi.fn(() => rejection as never) })).toThrow(
      'Evidence review unavailable'
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('rechecks host authority after callback reentry', async () => {
    let valid = true;
    expect(() =>
      fixture({
        assertAuthority: vi.fn(() => {
          if (!valid) throw new Error('PRIVATE-REVOKED');
        }),
        assertAuthorized: vi.fn(() => {
          valid = false;
        }),
      })
    ).toThrow('Evidence review unavailable');
  });

  it('rejects an aggregate snapshot that exceeds the shared canonical budget', async () => {
    const f = fixture({
      action: { operation: 'submit', publicMetadata: 'a'.repeat(34_000) },
      collect: vi.fn(async () => ({ witness: 'w'.repeat(34_000) })),
    });
    await expect(f.prepared.generate(new AbortController().signal)).rejects.toThrow(
      'Evidence review unavailable'
    );
    expect(f.gate.getTokenCount()).toBe(0);
  });

  it.each([null, undefined, 1, 'text', []])(
    'refuses missing or non-record evidence %j without allocating a token',
    async (witness) => {
      const f = fixture({ collect: vi.fn(async () => witness) });
      await expect(f.prepared.generate(new AbortController().signal)).rejects.toThrow(
        'Evidence review unavailable'
      );
      expect(f.gate.getTokenCount()).toBe(0);
    }
  );

  it('pins a detached review context before collection yields', async () => {
    const mutable = { ...context };
    let release!: () => void;
    const f = fixture({
      context: mutable,
      collect: vi.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ documentId: 'doc-1' });
          })
      ),
    });
    const pending = f.prepared.generate(new AbortController().signal);
    mutable.epoch = 99;
    mutable.sessionId = 'mutated';
    release();
    const token = await pending;
    await expect(f.gate.getReviewedApproval(token.tokenId, context)).resolves.toBeDefined();
    await expect(f.gate.getReviewedApproval(token.tokenId, mutable)).resolves.toBeUndefined();
  });

  it('keeps denied and expired tokens unusable and permits only one concurrent consume', async () => {
    const signal = new AbortController().signal;
    const denied = fixture();
    const deniedToken = await denied.prepared.generate(signal);
    await denied.prepared.decide(deniedToken.tokenId, 'deny', signal);
    expect(await denied.prepared.consume(deniedToken.tokenId, signal)).toBe(false);

    const gate = new ApprovalGate({ tokenTtlMs: 1 });
    const expired = fixture({ gate });
    const expiredToken = await expired.prepared.generate(signal);
    await expired.prepared.decide(expiredToken.tokenId, 'approve', signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await expired.prepared.consume(expiredToken.tokenId, signal)).toBe(false);

    const concurrent = fixture();
    const live = await concurrent.prepared.generate(signal);
    await concurrent.prepared.decide(live.tokenId, 'approve', signal);
    expect(
      (
        await Promise.all([
          concurrent.prepared.consume(live.tokenId, signal),
          concurrent.prepared.consume(live.tokenId, signal),
        ])
      ).sort()
    ).toEqual([false, true]);
  });

  it.each(['authority', 'source', 'collector', 'disclosure', 'track'] as const)(
    'sanitizes private %s failures',
    async (boundary) => {
      const failure = () => {
        throw new Error(`PRIVATE-${boundary}`);
      };
      let error: unknown;
      try {
        const f = fixture({
          ...(boundary === 'authority' ? { assertAuthority: failure } : {}),
          ...(boundary === 'source' ? { assertAuthorized: failure } : {}),
          ...(boundary === 'collector' ? { collect: failure } : {}),
          ...(boundary === 'disclosure' ? { assertDisclosureSafe: failure } : {}),
          ...(boundary === 'track' ? { trackRead: failure as never } : {}),
        });
        await f.prepared.generate(new AbortController().signal);
      } catch (caught) {
        error = caught;
      }
      expect(error).toEqual(new Error('Evidence review unavailable'));
      expect(JSON.stringify(error)).not.toContain('PRIVATE');
    }
  );

  it('rejects malformed source descriptors, actions, permissions and aborted calls statically', async () => {
    expect(() => fixture({ action: [] as never })).toThrow('Evidence review unavailable');
    expect(() =>
      prepareEvidencePermission({ generation: 1, currentGeneration: async () => 1 })
    ).toThrow('Evidence authorization unavailable');
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.prepared.generate(controller.signal)).rejects.toThrow(
      'Evidence review unavailable'
    );
    expect(f.source.collect).not.toHaveBeenCalled();
  });

  it('rejects hidden action data without invoking its accessor and honors lifecycle cancellation', async () => {
    const getter = vi.fn(() => 'private');
    const action = { operation: 'submit' };
    Object.defineProperty(action, 'hidden', { enumerable: false, value: 'private' });
    Object.defineProperty(action, 'computed', { enumerable: true, get: getter });
    expect(() => fixture({ action })).toThrow('Evidence review unavailable');
    expect(getter).not.toHaveBeenCalled();

    const lifecycle = new AbortController();
    lifecycle.abort();
    expect(() => fixture({ lifecycleSignal: lifecycle.signal })).toThrow(
      'Evidence review unavailable'
    );
  });

  it('uses captured gate methods even if callers replace the instance methods later', async () => {
    const f = fixture();
    f.gate.generateReviewedApproval = vi.fn(async () => {
      throw new Error('PRIVATE-REPLACEMENT');
    });
    f.gate.getReviewedApproval = vi.fn(async () => undefined);
    f.gate.decideReviewedApproval = vi.fn(async () => undefined);
    f.gate.consumeReviewedApproval = vi.fn(async () => false);
    const signal = new AbortController().signal;
    const token = await f.prepared.generate(signal);
    expect(await f.prepared.get(token.tokenId, signal)).toBeDefined();
    expect((await f.prepared.decide(token.tokenId, 'approve', signal))?.status).toBe('approved');
    expect(await f.prepared.consume(token.tokenId, signal)).toBe(true);
  });
});
