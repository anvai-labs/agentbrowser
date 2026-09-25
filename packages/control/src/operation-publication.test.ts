import { afterEach, expect, it, vi } from 'vitest';
import type { OperationPublication, PublicationContext } from './publication.js';
import { SessionAuthority, type SessionPrincipal } from './session-authority.js';

const operator = { actor: 'operator' as const, tenant: 'owner' };
const owners: SessionAuthority[] = [];
afterEach(() => {
  for (const authority of owners.splice(0)) authority.remove('s');
});
function fixture(options: { now?: () => number; ttlMs?: number } = {}) {
  const authority = new SessionAuthority(options);
  owners.push(authority);
  authority.register('s', 'owner', new AbortController().signal, options);
  const control = authority.get('s');
  if (!control) throw new Error('fixture owner missing');
  const seed = () =>
    authority.run('s', operator, { id: 'write', fingerprint: 'a' }, async () => {
      await authority.dispatchInScope('s', () => 42);
      return 42;
    });
  const delegate = () => {
    const review = control.prepareResume();
    const grant = authority.delegate('s', review.epoch);
    const principal = authority.authenticate(grant.token);
    if (!principal) throw new Error('fixture grant missing');
    return principal;
  };
  return { authority, control, seed, delegate };
}

for (const state of ['agent', 'drain'] as const) {
  it(`lets operator inspect an active ${state} operation without taking its ticket`, async () => {
    const f = fixture();
    const agent = f.delegate();
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const work = f.authority
      .run('s', agent, { id: 'write', fingerprint: 'a' }, async () => {
        entered.resolve();
        await f.authority.dispatchInScope('s', () => release.promise);
        return 42;
      })
      .catch((error: unknown) => error);
    await entered.promise;
    if (state === 'drain') f.authority.takeover('s');
    const publish = vi.fn((record, context: PublicationContext) => {
      expect(record).toMatchObject({ operationId: 'write', status: 'in_flight', dispatched: true });
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.keys(context).sort()).toEqual(['assertCurrent', 'signal']);
      context.assertCurrent();
      expect(f.control.view().busy).toBe(true);
    });
    try {
      const record = await f.authority.publishOperation('s', operator, 'write', {
        timeoutMs: 1000,
        publish,
      });
      expect(record?.status).toBe('in_flight');
      expect(publish).toHaveBeenCalledTimes(1);
      await expect(f.authority.run('s', operator, {}, async () => 0)).rejects.toThrow();
      expect(f.control.view().busy).toBe(true);
    } finally {
      release.resolve();
      await work;
    }
  });
}

it('keeps an in-flight snapshot frozen when the original operation completes during publication', async () => {
  const f = fixture();
  const release = Promise.withResolvers<void>();
  const work = f.authority.run(
    's',
    operator,
    { id: 'write', fingerprint: 'a' },
    () => release.promise
  );
  let retained!: () => void;
  try {
    const record = await f.authority.publishOperation('s', operator, 'write', {
      timeoutMs: 1000,
      publish: async (snapshot, context) => {
        retained = context.assertCurrent;
        expect(Reflect.set(snapshot, 'status', 'failed')).toBe(false);
        release.resolve();
        await work;
        expect(f.control.operation('write')?.status).toBe('completed');
        expect(snapshot.status).toBe('in_flight');
        context.assertCurrent();
      },
    });
    expect(record?.status).toBe('in_flight');
    expect(retained).toThrow();
  } finally {
    release.resolve();
    await work;
  }
});

it('does not lend an enclosing execution scope to its publisher and restores the caller scope', async () => {
  const f = fixture();
  await f.seed();
  const effect = vi.fn();
  await f.authority.run('s', operator, { id: 'outer', fingerprint: 'outer' }, async () => {
    await f.authority.publishOperation('s', operator, 'write', {
      timeoutMs: 1000,
      publish: (_record, context) => {
        context.assertCurrent();
        expect(() => f.authority.assert('s')).toThrow();
        expect(() => f.authority.dispatchInScope('s', effect)).toThrow();
        expect(() => f.authority.trackReadInScope('s', effect)).toThrow();
      },
    });
    f.authority.assert('s');
    await f.authority.dispatchInScope('s', effect);
  });
  expect(effect).toHaveBeenCalledTimes(1);
});

it('denies another tenant and a current agent inspecting a previous-epoch record', async () => {
  const f = fixture();
  await f.seed();
  const agent = f.delegate();
  const publish = vi.fn();
  for (const principal of [{ actor: 'operator' as const, tenant: 'other' }, agent]) {
    await expect(
      f.authority.publishOperation('s', principal, 'write', { timeoutMs: 1000, publish })
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
  }
  expect(publish).not.toHaveBeenCalled();
  await f.authority.publishOperation('s', operator, 'write', { timeoutMs: 1000, publish });
  expect(publish).toHaveBeenCalledTimes(1);
});

it('accepts the current agent for its own record and refuses a revoked grant', async () => {
  const f = fixture();
  const agent = f.delegate();
  await f.authority.run('s', agent, { id: 'write', fingerprint: 'a' }, async () => 1);
  const publish = vi.fn();
  await f.authority.publishOperation('s', agent, 'write', { timeoutMs: 1000, publish });
  expect(publish).toHaveBeenCalledTimes(1);
  f.authority.takeover('s');
  await expect(
    f.authority.publishOperation('s', agent, 'write', { timeoutMs: 1000, publish })
  ).rejects.toThrow();
  expect(publish).toHaveBeenCalledTimes(1);
});

for (const change of ['takeover', 'review', 'remove', 'replace'] as const) {
  it(`suppresses a captured status after ${change} without releasing a replacement ticket`, async () => {
    const f = fixture();
    await f.seed();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const nextRelease = Promise.withResolvers<void>();
    let next: Promise<unknown> | undefined;
    const sent = vi.fn();
    const result = f.authority
      .publishOperation('s', operator, 'write', {
        timeoutMs: 1000,
        publish: async (_record, context) => {
          entered.resolve();
          await release.promise;
          context.assertCurrent();
          sent();
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    await entered.promise;
    if (change === 'takeover') f.authority.takeover('s');
    if (change === 'review') f.control.invalidateReview();
    if (change === 'remove' || change === 'replace') f.authority.remove('s');
    if (change === 'replace') {
      f.authority.register('s', 'owner', new AbortController().signal);
      next = f.authority.run(
        's',
        operator,
        { id: 'write', fingerprint: 'replacement' },
        () => nextRelease.promise
      );
    }
    release.resolve();
    try {
      expect(await result).toMatchObject({ code: 'CONTROL_REVOKED' });
      expect(sent).not.toHaveBeenCalled();
      expect(f.control.operation('write')?.status).toBe('completed');
      if (change === 'replace') expect(f.authority.get('s')?.view().busy).toBe(true);
    } finally {
      nextRelease.resolve();
      await next;
    }
  });
}

for (const id of ['write', 'missing']) {
  it(`refuses expiry caused during lookup of ${id}`, async () => {
    let now = 0;
    const f = fixture({ now: () => now, ttlMs: 10 });
    await f.seed();
    const operation = f.control.publicationOperation.bind(f.control);
    vi.spyOn(f.control, 'publicationOperation').mockImplementation((key) => {
      now = 10;
      return operation(key);
    });
    const publish = vi.fn();
    await expect(
      f.authority.publishOperation('s', operator, id, { timeoutMs: 1000, publish })
    ).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
    expect(publish).not.toHaveBeenCalled();
  });
}

it('returns absent status without allocating a record or calling the publisher', async () => {
  const f = fixture();
  const begin = vi.spyOn(f.control, 'begin');
  const publish = vi.fn();
  expect(
    await f.authority.publishOperation('s', operator, 'missing', { timeoutMs: 1000, publish })
  ).toBeUndefined();
  expect(begin).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(f.control.operation('missing')).toBeUndefined();
});

it('refuses stopped and configuring owners even for missing records', async () => {
  const f = fixture();
  const publish = vi.fn();
  let attempted: Promise<unknown> | undefined;
  f.authority.configure('s', operator, () => {
    attempted = f.authority
      .publishOperation('s', operator, 'missing', { timeoutMs: 1000, publish })
      .then(
        () => undefined,
        (error: unknown) => error
      );
  });
  expect(await attempted).toMatchObject({ code: 'CONTROL_REVOKED' });
  f.control.stop();
  await expect(
    f.authority.publishOperation('s', operator, 'missing', { timeoutMs: 1000, publish })
  ).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  expect(publish).not.toHaveBeenCalled();
});

it('snapshots caller principal and publisher before awaiting output', async () => {
  const f = fixture();
  await f.seed();
  const principal: SessionPrincipal = { ...operator };
  const original = vi.fn((_record, context: PublicationContext) => {
    principal.tenant = 'other';
    context.assertCurrent();
  });
  const replacement = vi.fn();
  const options = { timeoutMs: 1000, publish: original };
  const result = f.authority.publishOperation('s', principal, 'write', options);
  options.publish = replacement;
  options.timeoutMs = 0;
  await result;
  expect(original).toHaveBeenCalledTimes(1);
  expect(replacement).not.toHaveBeenCalled();
});

for (const cause of ['timeout', 'cancel'] as const) {
  it(`closes late output on ${cause} without finishing a live operation`, async () => {
    const f = fixture();
    const release = Promise.withResolvers<void>();
    const work = f.authority.run(
      's',
      operator,
      { id: 'write', fingerprint: 'a' },
      () => release.promise
    );
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    const abort = new AbortController();
    const sent = vi.fn();
    let context: PublicationContext | undefined;
    try {
      const result = f.authority
        .publishOperation('s', operator, 'write', {
          timeoutMs: cause === 'timeout' ? 20 : 1000,
          signal: abort.signal,
          publish: async (_record, output) => {
            context = output;
            entered.resolve();
            await late.promise;
            output.assertCurrent();
            sent();
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      await entered.promise;
      if (cause === 'cancel') abort.abort();
      expect(await result).toMatchObject({ code: 'CONTROL_REVOKED' });
      expect(context?.signal.aborted).toBe(true);
      expect(() => context?.assertCurrent()).toThrow();
      expect(f.control.view()).toMatchObject({ busy: true, operation: { status: 'in_flight' } });
    } finally {
      late.resolve();
      release.resolve();
      await work;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(sent).not.toHaveBeenCalled();
  });
}

it('refuses invalid ID and options without calling a publisher', async () => {
  const f = fixture();
  const publish = vi.fn();
  const options = { timeoutMs: 1000, publish };
  await expect(
    f.authority.publishOperation('s', operator, '../bad', options)
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(
    f.authority.publishOperation('s', operator, 'write', { ...options, timeoutMs: 0 })
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(
    f.authority.publishOperation('s', operator, 'write', {
      ...options,
      publish: null,
    } as unknown as OperationPublication)
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(publish).not.toHaveBeenCalled();
});

it('refuses a replacement created in the scheduling gap before handing the snapshot to a publisher', async () => {
  const f = fixture();
  await f.seed();
  const publish = vi.fn();
  const pending = f.authority.publishOperation('s', operator, 'write', {
    timeoutMs: 1000,
    publish,
  });
  f.authority.remove('s');
  f.authority.register('s', 'owner', new AbortController().signal);
  await expect(pending).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  expect(publish).not.toHaveBeenCalled();
});

it('preserves execution facts and the caller scope when a status publisher rejects', async () => {
  const f = fixture();
  await f.seed();
  const failure = new Error('delivery failed');
  await f.authority.run('s', operator, {}, async () => {
    await expect(
      f.authority.publishOperation('s', operator, 'write', {
        timeoutMs: 1000,
        publish: () => {
          throw failure;
        },
      })
    ).rejects.toBe(failure);
    f.authority.assert('s');
  });
  expect(f.control.operation('write')?.status).toBe('completed');
});

it('refuses changed agent mode and binding generation through the existing identity owner', async () => {
  const f = fixture();
  const agent = f.delegate();
  await f.authority.run('s', agent, { id: 'write', fingerprint: 'a' }, async () => 1);
  const publish = vi.fn();
  for (const changed of [
    { ...agent, mode: 'application' as const },
    { ...agent, bindingGeneration: 'stale' },
  ]) {
    await expect(
      f.authority.publishOperation('s', changed, 'write', { timeoutMs: 1000, publish })
    ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
  }
  expect(publish).not.toHaveBeenCalled();
});

it('checks authority after a publisher returns without calling its guard', async () => {
  const f = fixture();
  await f.seed();
  await expect(
    f.authority.publishOperation('s', operator, 'write', {
      timeoutMs: 1000,
      publish: () => {
        f.authority.takeover('s');
      },
    })
  ).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  expect(f.control.operation('write')?.status).toBe('completed');
});

it('pre-aborted publication does not invoke the publisher or change the inspected record', async () => {
  const f = fixture();
  await f.seed();
  const abort = new AbortController();
  abort.abort();
  const publish = vi.fn();
  await expect(
    f.authority.publishOperation('s', operator, 'write', {
      timeoutMs: 1000,
      signal: abort.signal,
      publish,
    })
  ).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  expect(publish).not.toHaveBeenCalled();
  expect(f.control.operation('write')?.status).toBe('completed');
});

const identity = { id: 'write', fingerprint: 'a' };
function replay(
  f: ReturnType<typeof fixture>,
  publication: OperationPublication,
  principal = operator
) {
  return f.authority.run(
    's',
    principal,
    identity,
    async () => {
      throw new Error('duplicate executed');
    },
    undefined,
    undefined,
    publication
  );
}

it('validates replay publication before admitting a fresh effect', async () => {
  const f = fixture();
  const effect = vi.fn();
  await expect(
    f.authority.run('s', operator, identity, effect, undefined, undefined, {
      timeoutMs: 0,
      publish: vi.fn(),
    })
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(effect).not.toHaveBeenCalled();
  expect(f.control.operation('write')).toBeUndefined();
});

for (const phase of ['execution', 'drain', 'publication'] as const) {
  it(`publishes a duplicate during ${phase} without finishing the original ticket`, async () => {
    const f = fixture();
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const effect = vi.fn(() => release.promise);
    const original = f.authority.run(
      's',
      operator,
      identity,
      async () => {
        if (phase === 'drain') {
          void f.authority.dispatchInScope('s', effect);
          entered.resolve();
        } else if (phase === 'execution') {
          entered.resolve();
          await f.authority.dispatchInScope('s', effect);
        }
        return 42;
      },
      undefined,
      phase === 'publication'
        ? {
            timeoutMs: 1000,
            publish: async () => {
              entered.resolve();
              await release.promise;
            },
          }
        : undefined
    );
    await entered.promise;
    const finish = vi.spyOn(f.control, 'finish');
    const publish = vi.fn((record, context: PublicationContext) => {
      expect(record.status).toBe(phase === 'publication' ? 'completed' : 'in_flight');
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.keys(context).sort()).toEqual(['assertCurrent', 'signal']);
      context.assertCurrent();
    });
    try {
      await replay(f, { timeoutMs: 1000, publish });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(f.control.view().busy).toBe(true);
      expect(finish).not.toHaveBeenCalled();
      expect(effect).toHaveBeenCalledTimes(phase === 'publication' ? 0 : 1);
    } finally {
      release.resolve();
      await original;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(f.control.operation('write')?.status).toBe(
      phase === 'drain' ? 'outcome_unknown' : 'completed'
    );
  });
}

it('isolates nested replay publication and restores the enclosing execution scope', async () => {
  const f = fixture();
  await f.seed();
  const effect = vi.fn();
  const publish = vi.fn(async (_record, context: PublicationContext) => {
    await Promise.resolve();
    context.assertCurrent();
    expect(() => f.authority.dispatchInScope('s', effect)).toThrow();
    expect(() => f.authority.trackReadInScope('s', effect)).toThrow();
  });
  await f.authority.run('s', operator, { id: 'outer', fingerprint: 'outer' }, async () => {
    await replay(f, { timeoutMs: 1000, publish });
    await f.authority.dispatchInScope('s', effect);
  });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(effect).toHaveBeenCalledTimes(1);
});

it('rejects core identity conflicts before replay publication', async () => {
  const f = fixture();
  await f.seed();
  const publish = vi.fn();
  await expect(
    f.authority.run(
      's',
      operator,
      { ...identity, fingerprint: 'different' },
      vi.fn(),
      undefined,
      undefined,
      { timeoutMs: 1000, publish }
    )
  ).rejects.toThrow();
  const agent = f.delegate();
  await expect(
    f.authority.run('s', agent, identity, vi.fn(), undefined, undefined, {
      timeoutMs: 1000,
      publish,
    })
  ).rejects.toThrow();
  expect(publish).not.toHaveBeenCalled();
  expect(f.control.operation('write')?.status).toBe('completed');
});

it('pins replay owner before the scheduling gap and never looks up a replacement record', async () => {
  const f = fixture();
  await f.seed();
  const publish = vi.fn();
  const outcome = replay(f, { timeoutMs: 1000, publish }).catch((error) => error);
  f.authority.remove('s');
  f.authority.register('s', 'owner', new AbortController().signal);
  const release = Promise.withResolvers<void>();
  const next = f.authority.run('s', operator, identity, () => release.promise);
  try {
    expect(await outcome).toMatchObject({ code: 'CONTROL_REVOKED' });
    expect(publish).not.toHaveBeenCalled();
    expect(f.authority.get('s')?.view().busy).toBe(true);
  } finally {
    release.resolve();
    await next;
  }
});

for (const cause of ['timeout', 'cancel', 'replace', 'review'] as const) {
  it(`closes delayed replay after ${cause} without releasing execution or changing facts`, async () => {
    const f = fixture();
    const release = Promise.withResolvers<void>();
    const original = f.authority
      .run('s', operator, identity, () => release.promise)
      .catch((error) => error);
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    const cancelled = new AbortController();
    const sent = vi.fn();
    let retained: PublicationContext | undefined;
    let next: Promise<unknown> | undefined;
    const outcome = replay(f, {
      timeoutMs: cause === 'timeout' ? 20 : 1000,
      signal: cancelled.signal,
      publish: async (_record, context) => {
        retained = context;
        entered.resolve();
        await late.promise;
        context.assertCurrent();
        sent();
      },
    }).catch((error) => error);
    await Promise.race([entered.promise, outcome]);
    if (cause === 'cancel') cancelled.abort();
    if (cause === 'review') f.control.invalidateReview();
    if (cause === 'replace') {
      f.authority.remove('s');
      f.authority.register('s', 'owner', new AbortController().signal);
      next = f.authority.run('s', operator, identity, () => release.promise);
    }
    if (cause === 'review' || cause === 'replace') late.resolve();
    try {
      expect(await outcome).toMatchObject({ code: 'CONTROL_REVOKED' });
      expect(retained).toBeDefined();
      expect(retained?.assertCurrent).toThrow();
      expect(f.authority.get('s')?.view().busy).toBe(true);
      expect(sent).not.toHaveBeenCalled();
    } finally {
      late.resolve();
      release.resolve();
      await original;
      await next;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(sent).not.toHaveBeenCalled();
  });
}

it('snapshots replay callback and principal while keeping no-options replay unchanged', async () => {
  const f = fixture();
  await f.seed();
  const principal = { ...operator };
  const original = vi.fn();
  const replacement = vi.fn();
  const publication = { timeoutMs: 1000, publish: original };
  const outcome = replay(f, publication, principal);
  principal.tenant = 'other';
  publication.publish = replacement;
  publication.timeoutMs = 0;
  await outcome;
  expect(original).toHaveBeenCalledTimes(1);
  expect(replacement).not.toHaveBeenCalled();
  expect(await f.authority.run('s', operator, identity, vi.fn())).toMatchObject({
    replay: true,
    operation: { status: 'completed' },
  });
});

it('authorizes current-agent replay and revokes delayed output after takeover', async () => {
  const f = fixture();
  const agent = f.delegate();
  await f.authority.run('s', agent, identity, async () => 42);
  const first = vi.fn();
  await f.authority.run('s', agent, identity, vi.fn(), undefined, undefined, {
    timeoutMs: 1000,
    publish: first,
  });
  expect(first).toHaveBeenCalledTimes(1);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sent = vi.fn();
  const outcome = f.authority
    .run('s', agent, identity, vi.fn(), undefined, undefined, {
      timeoutMs: 1000,
      publish: async (_record, context) => {
        entered.resolve();
        await release.promise;
        context.assertCurrent();
        sent();
      },
    })
    .catch((error) => error);
  await Promise.race([entered.promise, outcome]);
  f.authority.takeover('s');
  release.resolve();
  expect(await outcome).toMatchObject({ code: 'CONTROL_REQUIRED' });
  expect(sent).not.toHaveBeenCalled();
  expect(f.control.operation('write')?.status).toBe('completed');
});

for (const failure of ['preabort', 'callback'] as const) {
  it(`preserves outcome_unknown when replay delivery fails by ${failure}`, async () => {
    const f = fixture();
    await expect(
      f.authority.run('s', operator, identity, async () => {
        await f.authority.dispatchInScope('s', () => {
          throw new Error('uncertain effect');
        });
      })
    ).rejects.toThrow();
    const cancel = new AbortController();
    if (failure === 'preabort') cancel.abort();
    const publish = vi.fn(() => {
      throw new Error('publisher failed');
    });
    await expect(replay(f, { timeoutMs: 1000, signal: cancel.signal, publish })).rejects.toThrow();
    expect(publish).toHaveBeenCalledTimes(failure === 'preabort' ? 0 : 1);
    expect(f.control.operation('write')?.status).toBe('outcome_unknown');
    expect(f.control.view().busy).toBe(false);
  });
}

it('refuses a replay initiated during owner configuration', async () => {
  const f = fixture();
  await f.seed();
  const publish = vi.fn();
  let outcome: Promise<unknown> | undefined;
  f.authority.configure('s', operator, () => {
    outcome = replay(f, { timeoutMs: 1000, publish }).catch((error) => error);
  });
  expect(await outcome).toMatchObject({ code: 'CONTROL_REVOKED' });
  expect(publish).not.toHaveBeenCalled();
  expect(f.control.operation('write')?.status).toBe('completed');
});
