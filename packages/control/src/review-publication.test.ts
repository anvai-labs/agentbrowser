import { afterEach, expect, it, vi } from 'vitest';
import {
  ApplicationAuthority,
  type PreparedApplicationOperationReview,
  defineApplicationOperation,
} from './application-authority.js';
import { SessionAuthority } from './session-authority.js';

const operator = { actor: 'operator' as const, tenant: 'owner' };
const operation = { id: 'review', fingerprint: 'review' };
const planned = {
  operation: 'submit',
  input: { name: 'Synthetic' },
  operationId: 'submit-1',
  expectedVersion: 0,
};
const owners: SessionAuthority[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.remove('s');
    owner.remove('other');
  }
});
function fixture(options: { now?: () => number; ttlMs?: number } = {}) {
  const authority = new SessionAuthority(options);
  owners.push(authority);
  authority.register('s', 'owner', new AbortController().signal, options);
  const control = authority.get('s');
  if (!control) throw new Error('Fixture owner missing');
  const authorize = vi.fn(() => true);
  const parse = vi.fn(() => null);
  const execute = vi.fn(async () => ({ status: 'committed' as const, value: 1 }));
  const receipt = vi.fn(async () => null);
  const consent = vi.fn(() => ({ consume: vi.fn(async () => true), assertCurrent: vi.fn() }));
  const app = new ApplicationAuthority(
    authority,
    [
      {
        id: 'app',
        authorize,
        receipt,
        operations: {
          submit: defineApplicationOperation({
            mode: 'write',
            review: 'operator-submit',
            parse,
            execute,
          }),
        },
      },
    ],
    { consentPolicy: consent }
  );
  app.bind('s', operator, { adapter: 'app', resource: 'account' });
  const capture = () => app.prepareOperationReviewInScope('s', planned);
  return { authority, control, app, capture, authorize, parse, execute, receipt, consent };
}

it('uses the captured review owner only during its actual publication while reads stay closed', async () => {
  const f = fixture();
  let session!: ReturnType<SessionAuthority['captureReviewPublicationInScope']>;
  let review!: PreparedApplicationOperationReview;
  let read!: () => void;
  const publish = vi.fn((_value, context) => {
    expect(context.status).toBe('completed');
    expect(f.control.view().busy).toBe(true);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.binding)).toBe(true);
    expect(Object.isFrozen(review.publication)).toBe(true);
    session.assertCurrent();
    review.publication.assertCurrent();
    f.authorize.mockClear();
    review.publication.assertPinned();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(read).toThrow();
    expect(review.assertCurrent).toThrow();
    expect(review.assertPinned).toThrow();
    expect(() => f.authority.dispatchInScope('s', f.execute)).toThrow();
    expect(() => f.authority.trackReadInScope('s', f.receipt)).toThrow();
    // A refused read does not turn the independent publication fence into a read grant.
    review.publication.assertCurrent();
    expect(() => f.authority.captureReviewPublicationInScope('s')).toThrow();
  });
  await f.authority.run(
    's',
    operator,
    operation,
    async () => {
      read = f.authority.outputGuard('s');
      session = f.authority.captureReviewPublicationInScope('s');
      expect(session.binding).toEqual(f.authority.reviewBindingInScope('s'));
      review = f.capture();
      return review.action;
    },
    undefined,
    { timeoutMs: 1000, publish }
  );
  expect(publish).toHaveBeenCalledOnce();
  expect(session.assertCurrent).toThrow();
  expect(review.publication.assertCurrent).toThrow();
  expect(f.parse).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.receipt).not.toHaveBeenCalled();
  expect(f.consent).not.toHaveBeenCalled();
  expect(f.control.operation('review')?.status).toBe('completed');
});

it('refuses output checks during execution and after a run without publication', async () => {
  const f = fixture();
  let guard!: () => void;
  let review!: ReturnType<SessionAuthority['captureReviewPublicationInScope']>;
  await f.authority.run('s', operator, {}, async () => {
    guard = f.authority.publicationGuardInScope('s');
    review = f.authority.captureReviewPublicationInScope('s');
    expect(guard).toThrow();
    expect(review.assertCurrent).toThrow();
  });
  expect(guard).toThrow();
  expect(review.assertCurrent).toThrow();
  expect(() => f.authority.publicationGuardInScope('s')).toThrow();
  expect(() => f.authority.captureReviewPublicationInScope('s')).toThrow();
});

for (const actor of ['foreign', 'agent', 'resume', 'configuring'] as const) {
  it(`refuses review publication capture for ${actor}`, async () => {
    const f = fixture();
    const capture = async () => f.authority.captureReviewPublicationInScope('s');
    let attempt: Promise<unknown>;
    if (actor === 'configuring') {
      attempt = Promise.resolve();
      f.authority.configure('s', operator, () => {
        attempt = f.authority.run('s', operator, {}, capture).catch((error) => error);
      });
      expect(await attempt).toMatchObject({ code: 'CONTROL_REQUIRED' });
      return;
    }
    const principal = actor === 'foreign' ? { ...operator, tenant: 'other' } : operator;
    if (actor === 'agent' || actor === 'resume') f.control.prepareResume();
    if (actor === 'agent') {
      const grant = f.authority.delegate('s', f.control.view().epoch);
      const agent = f.authority.authenticate(grant.token);
      if (!agent) throw new Error('Fixture agent missing');
      attempt = f.authority.run('s', agent, {}, capture);
    } else attempt = f.authority.run('s', principal, {}, capture);
    await expect(attempt).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
  });
}

it('cannot borrow another session publication during the original drain', async () => {
  const f = fixture();
  f.authority.register('other', 'owner', new AbortController().signal);
  const release = Promise.withResolvers<void>();
  let guard!: () => void;
  const originalPublisher = vi.fn(() => guard());
  const original = f.authority.run(
    's',
    operator,
    operation,
    async () => {
      guard = f.authority.publicationGuardInScope('s');
      void f.authority.trackReadInScope('s', () => release.promise);
    },
    undefined,
    { timeoutMs: 1000, publish: originalPublisher }
  );
  try {
    await f.authority.run('other', operator, {}, async () => 1, undefined, {
      timeoutMs: 1000,
      publish: () => {
        expect(guard).toThrow();
        expect(f.control.view().busy).toBe(true);
      },
    });
    expect(originalPublisher).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await original;
  }
  expect(originalPublisher).toHaveBeenCalledOnce();
  expect(guard).toThrow();
});

it('cannot revive a captured guard in a later operation on the same session', async () => {
  const f = fixture();
  let guard!: () => void;
  await f.authority.run(
    's',
    operator,
    {},
    async () => {
      guard = f.authority.publicationGuardInScope('s');
    },
    undefined,
    { timeoutMs: 1000, publish: () => guard() }
  );
  await f.authority.run('s', operator, {}, async () => 1, undefined, {
    timeoutMs: 1000,
    publish: () => expect(guard).toThrow(),
  });
});

for (const change of ['takeover', 'review', 'replace', 'expiry'] as const) {
  it(`refuses delayed review publication after ${change} without releasing replacement work`, async () => {
    let now = 0;
    const f = fixture({ now: () => now, ttlMs: 100 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const nextRelease = Promise.withResolvers<void>();
    let review!: ReturnType<SessionAuthority['captureReviewPublicationInScope']>;
    let next: Promise<unknown> | undefined;
    const sent = vi.fn();
    const outcome = f.authority
      .run(
        's',
        operator,
        operation,
        async () => {
          review = f.authority.captureReviewPublicationInScope('s');
        },
        undefined,
        {
          timeoutMs: 1000,
          publish: async () => {
            entered.resolve();
            await release.promise;
            review.assertCurrent();
            sent();
          },
        }
      )
      .catch((error) => error);
    await Promise.race([entered.promise, outcome]);
    if (change === 'takeover') f.authority.takeover('s');
    if (change === 'review') f.control.invalidateReview();
    if (change === 'expiry') now = 100;
    if (change === 'replace') {
      f.authority.remove('s');
      f.authority.register('s', 'owner', new AbortController().signal);
      next = f.authority.run('s', operator, operation, () => nextRelease.promise);
    }
    release.resolve();
    try {
      expect(await outcome).toMatchObject({ code: 'CONTROL_REVOKED' });
      expect(sent).not.toHaveBeenCalled();
      expect(f.control.operation('review')?.status).toBe('completed');
      if (next) expect(f.authority.get('s')?.view().busy).toBe(true);
    } finally {
      nextRelease.resolve();
      await next;
    }
  });
}

for (const cause of ['timeout', 'cancel', 'throw'] as const) {
  it(`closes the captured publication phase after ${cause} before a late callback settles`, async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    const cancelled = new AbortController();
    let guard!: () => void;
    const sent = vi.fn();
    const outcome = f.authority
      .run(
        's',
        operator,
        operation,
        async () => {
          guard = f.authority.publicationGuardInScope('s');
        },
        undefined,
        {
          timeoutMs: cause === 'timeout' ? 20 : 1000,
          signal: cancelled.signal,
          publish: async () => {
            entered.resolve();
            if (cause === 'throw') throw new Error('delivery failed');
            await late.promise;
            guard();
            sent();
          },
        }
      )
      .catch((error) => error);
    await Promise.race([entered.promise, outcome]);
    if (cause === 'cancel') cancelled.abort();
    try {
      expect(await outcome).toBeInstanceOf(Error);
      expect(guard).toThrow();
      expect(f.control.operation('review')?.status).toBe('completed');
      expect(f.control.view().busy).toBe(false);
    } finally {
      late.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(sent).not.toHaveBeenCalled();
  });
}

for (const change of ['denial', 'generation', 'replacement', 'takeover'] as const) {
  it(`checks application publication access after ${change} and latches refusal`, async () => {
    const f = fixture();
    let review!: PreparedApplicationOperationReview;
    const sent = vi.fn();
    let checked = false;
    const outcome = f.authority.run(
      's',
      operator,
      operation,
      async () => {
        review = f.capture();
      },
      undefined,
      {
        timeoutMs: 1000,
        publish: () => {
          review.publication.assertCurrent();
          checked = true;
          if (change === 'denial') f.authorize.mockReturnValue(false);
          if (change === 'generation') f.control.invalidateReview();
          if (change === 'replacement' || change === 'takeover')
            f.authorize.mockImplementation(() => {
              if (change === 'replacement') {
                f.authority.remove('s');
                f.authority.register('s', 'owner', new AbortController().signal);
              } else f.authority.takeover('s');
              return true;
            });
          expect(review.publication.assertCurrent).toThrow();
          f.authorize.mockReturnValue(true);
          review.publication.assertCurrent();
          sent();
        },
      }
    );
    await expect(outcome).rejects.toThrow();
    expect(checked).toBe(true);
    expect(sent).not.toHaveBeenCalled();
    expect(f.parse).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.receipt).not.toHaveBeenCalled();
    expect(f.consent).not.toHaveBeenCalled();
    expect(f.control.operation('review')?.status).toBe('completed');
  });
}

it('suppresses application permission revoked while publication waits', async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let review!: PreparedApplicationOperationReview;
  const sent = vi.fn();
  const outcome = f.authority
    .run(
      's',
      operator,
      operation,
      async () => {
        review = f.capture();
      },
      undefined,
      {
        timeoutMs: 1000,
        publish: async () => {
          entered.resolve();
          await release.promise;
          review.publication.assertCurrent();
          sent();
        },
      }
    )
    .catch((error) => error);
  await Promise.race([entered.promise, outcome]);
  f.authorize.mockReturnValue(false);
  release.resolve();
  expect(await outcome).toMatchObject({ code: 'CONTROL_REQUIRED' });
  expect(sent).not.toHaveBeenCalled();
});

it('closes captured output before finish releases the ticket', async () => {
  const f = fixture();
  let guard!: () => void;
  const finish = f.control.finish.bind(f.control);
  const checked = vi.spyOn(f.control, 'finish').mockImplementation((ticket, status) => {
    expect(f.control.view().busy).toBe(true);
    expect(guard).toThrow();
    finish(ticket, status);
  });
  await f.authority.run(
    's',
    operator,
    operation,
    async () => {
      guard = f.authority.publicationGuardInScope('s');
    },
    undefined,
    {
      timeoutMs: 1000,
      publish: async () => {
        await Promise.resolve();
        guard();
      },
    }
  );
  expect(checked).toHaveBeenCalledOnce();
});

it('never activates review publication for pre-aborted output', async () => {
  const f = fixture();
  const cancelled = new AbortController();
  cancelled.abort();
  let review!: PreparedApplicationOperationReview;
  const publish = vi.fn();
  await expect(
    f.authority.run(
      's',
      operator,
      operation,
      async () => {
        review = f.capture();
      },
      undefined,
      { timeoutMs: 1000, signal: cancelled.signal, publish }
    )
  ).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  expect(publish).not.toHaveBeenCalled();
  expect(review.publication.assertCurrent).toThrow();
  expect(f.control.operation('review')?.status).toBe('completed');
});
