import assert from 'node:assert/strict';
import { afterEach, expect, it, vi } from 'vitest';
import {
  type ApplicationAdapter,
  ApplicationAuthority,
  type ApplicationConsentPolicy,
  type ApplicationRequest,
  type PreparedApplicationOperationReview,
  defineApplicationOperation,
} from './application-authority.js';
import { SessionAuthority } from './session-authority.js';

const operator = { actor: 'operator' as const, tenant: 'owner' };
const planned = (): ApplicationRequest => ({
  operation: 'submit',
  operationId: 'submit-1',
  expectedVersion: 2,
  input: { answer: 'original' },
});
const owners: SessionAuthority[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.remove('session');
});
function fixture(policy?: ApplicationConsentPolicy) {
  const authority = new SessionAuthority();
  owners.push(authority);
  authority.register('session', 'owner', new AbortController().signal);
  const execute = vi.fn(async (input: unknown, scope: unknown) => ({
    status: 'committed' as const,
    value: { input, scope },
  }));
  const parse = vi.fn((input: unknown) => input);
  const authorize = vi.fn(() => true);
  const operation = defineApplicationOperation({
    mode: 'write',
    review: 'operator-submit',
    parse,
    execute,
  });
  const adapter: ApplicationAdapter = {
    id: 'app',
    authorize,
    operations: {
      submit: operation,
      ordinary: defineApplicationOperation({ mode: 'write', parse, execute }),
      read: defineApplicationOperation({
        mode: 'read',
        parse,
        execute: async () => ({ status: 'read', value: 1 }),
      }),
    },
    receipt: async () => null,
  };
  const port = new ApplicationAuthority(authority, [adapter], {
    ...(policy ? { consentPolicy: policy } : {}),
  });
  port.bind('session', operator, { adapter: 'app', resource: 'draft' });
  const run = <T>(fn: () => Promise<T>) => authority.run('session', operator, {}, fn);
  return { authority, port, execute, parse, authorize, operation, adapter, run };
}
const allowed = () => ({ consume: vi.fn(async () => true), assertCurrent: vi.fn(() => {}) });

it('exposes a callback-free final pin that still rejects revoked and escaped admissions', async () => {
  const f = fixture(() => allowed());
  let review!: PreparedApplicationOperationReview;
  await expect(
    f.run(async () => {
      review = f.port.prepareOperationReviewInScope('session', planned());
      f.authorize.mockClear();
      review.assertPinned();
      expect(f.authorize).not.toHaveBeenCalled();
      f.authority.takeover('session');
      expect(() => review.assertPinned()).toThrow();
    })
  ).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  expect(() => review.assertPinned()).toThrow();
});

it('discovers only the captured review requirement and leaves ordinary descriptors unchanged', async () => {
  const f = fixture(() => allowed());
  Reflect.set(f.adapter.operations, 'submit', { mode: 'write', prepare: f.operation.prepare });
  const discovery = await f.port.discover('session', operator);
  expect(discovery).toMatchObject({
    operations: [
      { name: 'submit', mode: 'write', review: 'operator-submit' },
      { name: 'ordinary', mode: 'write' },
      { name: 'read', mode: 'read' },
    ],
  });
  expect(discovery?.operations[1]).toEqual({ name: 'ordinary', mode: 'write' });
});

it('checks the final consent guard only after asynchronous consumption completes', async () => {
  let consumed = false;
  const guard = vi.fn(() => {
    if (!consumed) throw new Error('Consent has not been consumed');
  });
  const f = fixture(() => ({
    consume: async () => {
      await Promise.resolve();
      consumed = true;
      return true;
    },
    assertCurrent: guard,
  }));
  await expect(
    f.port.execute('session', operator, { ...planned(), approvalToken: 'token' })
  ).resolves.toMatchObject({ status: 'committed' });
  expect(guard).toHaveBeenCalledOnce();
  expect(f.execute).toHaveBeenCalledOnce();
});

it('fails protected execution without policy and records an undispatched refusal', async () => {
  const f = fixture();
  await expect(
    f.port.execute('session', operator, { ...planned(), approvalToken: 'token' })
  ).rejects.toThrow();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.authority.get('session')?.operation('submit-1')).toMatchObject({
    status: 'failed',
    dispatched: false,
  });
});
it('captures protected registration and requires a token without weakening ordinary operations', async () => {
  const consent = allowed();
  const policy = vi.fn(() => consent);
  const f = fixture(policy);
  expect(f.operation.review).toBe('operator-submit');
  await expect(f.port.execute('session', operator, planned())).rejects.toThrow();
  expect(policy).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  await expect(
    f.port.execute('session', operator, {
      ...planned(),
      operation: 'ordinary',
      approvalToken: 'token',
      operationId: 'ordinary-1',
    })
  ).rejects.toThrow();
  await expect(
    f.port.execute('session', operator, {
      ...planned(),
      operation: 'ordinary',
      operationId: 'ordinary-2',
      approvalToken: undefined,
    })
  ).resolves.toMatchObject({ status: 'committed' });
  expect(policy).not.toHaveBeenCalled();
});
it.each([
  ['read', 'operator-submit'],
  ['write', 'unknown'],
])('refuses invalid registration %s/%s', (mode, review) => {
  const authority = new SessionAuthority();
  expect(
    () =>
      new ApplicationAuthority(authority, [
        {
          id: 'invalid',
          authorize: () => true,
          operations: {
            op: { mode, review, prepare: () => async () => ({ status: 'read', value: 1 }) },
          },
          receipt: async () => null,
        } as ApplicationAdapter,
      ])
  ).toThrow();
});
it('builds a frozen review without preparing, executing, or reserving an operation', async () => {
  let executedAction: unknown;
  const consent = allowed();
  const f = fixture((review) => {
    executedAction = review.action;
    return consent;
  });
  let review!: PreparedApplicationOperationReview;
  await f.run(async () => {
    review = f.port.prepareOperationReviewInScope('session', planned());
    expect(review.action).toMatchObject({
      type: 'application-submit',
      intent: 'submit',
      tenant: 'owner',
      sessionId: 'session',
      sessionIncarnation: expect.any(String),
      adapter: 'app',
      resource: 'draft',
      bindingGeneration: expect.any(String),
      ...planned(),
    });
    expect(Object.isFrozen(review.action)).toBe(true);
    expect(Object.isFrozen(review.action.input)).toBe(true);
    review.assertCurrent();
    expect(f.authority.get('session')?.operation('submit-1')).toBeUndefined();
    expect(f.parse).not.toHaveBeenCalled();
  });
  expect(() => review.assertCurrent()).toThrow();
  await f.run(async () => expect(() => review.assertCurrent()).toThrow());
  await f.port.execute('session', operator, { ...planned(), approvalToken: 'token' });
  expect(executedAction).toEqual(review.action);
  expect(executedAction).not.toHaveProperty('approvalToken');
  expect(f.execute).toHaveBeenCalledOnce();
});
it('refuses review outside operator admission and refuses a planned approval token', async () => {
  const f = fixture();
  expect(() => f.port.prepareOperationReviewInScope('session', planned())).toThrow();
  await f.run(async () => {
    expect(() =>
      f.port.prepareOperationReviewInScope('session', { ...planned(), approvalToken: 'token' })
    ).toThrow();
    expect(() =>
      f.port.prepareOperationReviewInScope('session', { ...planned(), operation: 'ordinary' })
    ).toThrow();
  });
});
it('returns status-only exact replay but conflicts on a swapped token without another consume', async () => {
  const consent = allowed();
  const policy = vi.fn(() => consent);
  const f = fixture(policy);
  const request = { ...planned(), approvalToken: 'first' };
  await f.port.execute('session', operator, request);
  await expect(f.port.execute('session', operator, request)).resolves.toMatchObject({
    replay: true,
    operation: { status: 'completed', dispatched: true },
  });
  await expect(
    f.port.execute('session', operator, { ...request, approvalToken: 'second' })
  ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  expect(policy).toHaveBeenCalledOnce();
  expect(consent.consume).toHaveBeenCalledOnce();
  expect(f.execute).toHaveBeenCalledOnce();
});
it.each([false, undefined, 1, 'true'])(
  'accepts only literal true consumption (%s)',
  async (result) => {
    const f = fixture(() => ({ consume: async () => result as boolean, assertCurrent() {} }));
    await expect(
      f.port.execute('session', operator, { ...planned(), approvalToken: 'token' })
    ).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.authority.get('session')?.operation('submit-1')).toMatchObject({ dispatched: false });
  }
);
it.each(['async-policy', 'extra', 'getter', 'false-guard', 'async-guard', 'throw-guard'])(
  'refuses malformed consent %s statically',
  async (kind) => {
    const getter = vi.fn(() => async () => true);
    const policy = (() => {
      if (kind === 'async-policy') return Promise.reject(new Error('PRIVATE'));
      const handle = allowed();
      if (kind === 'extra') return { ...handle, extra: true };
      if (kind === 'getter') return Object.defineProperty(handle, 'consume', { get: getter });
      if (kind === 'false-guard') return { ...handle, assertCurrent: () => false };
      if (kind === 'async-guard')
        return {
          ...handle,
          assertCurrent: async () => {
            throw new Error('PRIVATE');
          },
        };
      return {
        ...handle,
        assertCurrent: () => {
          throw new Error('PRIVATE');
        },
      };
    }) as ApplicationConsentPolicy;
    const f = fixture(policy);
    const error = await f.port
      .execute('session', operator, { ...planned(), approvalToken: 'token' })
      .catch((error) => error);
    expect(error).toHaveProperty('code');
    expect(String(error)).not.toContain('PRIVATE');
    expect(getter).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
);
it.each(['getter', 'hidden', 'symbol', 'extra'])(
  'strictly snapshots the whole request (%s)',
  async (kind) => {
    const f = fixture(() => allowed());
    const request = { ...planned(), approvalToken: 'token' };
    const getter = vi.fn(() => 'submit');
    if (kind === 'getter') Object.defineProperty(request, 'operation', { get: getter });
    if (kind === 'hidden') Object.defineProperty(request, 'extra', { value: 1 });
    if (kind === 'symbol') Object.defineProperty(request, Symbol('extra'), { value: 1 });
    if (kind === 'extra') Object.assign(request, { extra: 1 });
    await expect(f.port.execute('session', operator, request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(getter).not.toHaveBeenCalled();
    expect(f.parse).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  }
);
it('pins caller fields and input before preparation and policy await', async () => {
  const request = { ...planned(), approvalToken: 'original-token' };
  let policyAction: unknown;
  const f = fixture((review, token) => {
    policyAction = review.action;
    expect(token).toBe('original-token');
    return {
      assertCurrent() {},
      consume: async () => {
        request.operationId = 'replacement';
        request.expectedVersion = 99;
        request.input = { answer: 'replacement' };
        return true;
      },
    };
  });
  f.parse.mockImplementation((input) => {
    request.operation = 'read';
    request.approvalToken = 'replacement';
    return input;
  });
  await f.port.execute('session', operator, request);
  expect(policyAction).toMatchObject({ ...planned(), type: 'application-submit' });
  expect(f.execute.mock.calls[0]?.[1]).toMatchObject({
    operationId: 'submit-1',
    expectedVersion: 2,
  });
});
it('deeply freezes protected preparation input before any consent is consumed', async () => {
  const consent = allowed();
  const f = fixture(() => consent);
  f.parse.mockImplementation((input) => {
    (input as { nested: { answer: string } }).nested.answer = 'changed';
    return input;
  });
  await expect(
    f.port.execute('session', operator, {
      ...planned(),
      input: { nested: { answer: 'original' } },
      approvalToken: 'token',
    })
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: 'Application preparation failed' });
  expect(consent.consume).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.authority.get('session')?.operation('submit-1')).toMatchObject({ dispatched: false });
});
it('preserves ordinary preparation input mutability', async () => {
  const f = fixture();
  f.parse.mockImplementation((input) => {
    (input as { answer: string }).answer = 'changed';
    return input;
  });
  await expect(
    f.port.execute('session', operator, { ...planned(), operation: 'ordinary' })
  ).resolves.toMatchObject({ status: 'committed' });
  expect(f.execute.mock.calls[0]?.[0]).toEqual({ answer: 'changed' });
});
it('normalizes proxy input before capturing a binding', async () => {
  let resource: unknown;
  const f = fixture((review) => {
    resource = review.action.resource;
    return allowed();
  });
  let rebound = false;
  const input = new Proxy(
    { answer: 'original' },
    {
      ownKeys(target) {
        if (!rebound) {
          rebound = true;
          f.port.bind('session', operator, { adapter: 'app', resource: 'new-draft' });
        }
        return Reflect.ownKeys(target);
      },
    }
  );
  await f.port.execute('session', operator, { ...planned(), input, approvalToken: 'token' });
  expect(resource).toBe('new-draft');
  expect(f.execute.mock.calls[0]?.[1]).toMatchObject({ resource: 'new-draft' });
});
it('runs final adapter authorization before final consent guard and never dispatches revoked permission', async () => {
  let consumed = false;
  let valid = true;
  const f = fixture(() => ({
    consume: async () => {
      consumed = true;
      return true;
    },
    assertCurrent: () => {
      if (!valid) throw new Error('PRIVATE');
    },
  }));
  f.authorize.mockImplementation(() => {
    if (consumed) valid = false;
    return true;
  });
  await expect(
    f.port.execute('session', operator, { ...planned(), approvalToken: 'token' })
  ).rejects.toThrow();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.authority.get('session')?.operation('submit-1')).toMatchObject({ dispatched: false });
});
it('checks callback-free pins after the final consent guard reenters takeover', async () => {
  let consumed = false;
  const f = fixture(() => ({
    consume: async () => {
      consumed = true;
      return true;
    },
    assertCurrent() {
      if (consumed) f.authority.takeover('session');
    },
  }));
  await expect(
    f.port.execute('session', operator, { ...planned(), approvalToken: 'token' })
  ).rejects.toThrow();
  expect(f.execute).not.toHaveBeenCalled();
});
it('refuses delegated execution even with a policy that approves everything', async () => {
  const policy = vi.fn(() => allowed());
  const f = fixture(policy);
  const control = f.authority.get('session');
  assert(control);
  const resume = control.prepareResume();
  const agent = f.authority.authenticate(f.authority.delegate('session', resume.epoch).token);
  assert(agent);
  await expect(
    f.port.execute('session', agent, { ...planned(), approvalToken: 'token' })
  ).rejects.toThrow();
  expect(policy).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
});

it('captures registration and policy methods instead of rereading replacements', async () => {
  const f = fixture();
  const replacement = vi.fn(async () => ({ status: 'committed' as const, value: 'unreviewed' }));
  const registered = {
    mode: 'write' as const,
    review: 'operator-submit' as const,
    prepare: (_input: unknown) => f.execute.bind(undefined, 'original'),
  };
  const consent = allowed();
  const originalConsume = consent.consume;
  const originalCurrent = consent.assertCurrent;
  originalConsume.mockImplementation(async () => {
    consent.assertCurrent = vi.fn(() => {
      throw new Error('replacement guard');
    });
    consent.consume = vi.fn(async () => false);
    return true;
  });
  const policy = vi.fn(() => consent);
  const options = { consentPolicy: policy };
  const port = new ApplicationAuthority(
    f.authority,
    [{ ...f.adapter, operations: { submit: registered } }],
    options
  );
  port.bind('session', operator, { adapter: 'app', resource: 'draft' });
  options.consentPolicy = vi.fn(() => {
    throw new Error('replacement policy');
  });
  Object.assign(registered, { review: undefined, prepare: () => replacement });
  await port.execute('session', operator, { ...planned(), approvalToken: 'token' });
  expect(policy).toHaveBeenCalledOnce();
  expect(options.consentPolicy).not.toHaveBeenCalled();
  expect(originalConsume).toHaveBeenCalledOnce();
  expect(originalCurrent).toHaveBeenCalledOnce();
  expect(consent.assertCurrent).not.toHaveBeenCalled();
  expect(replacement).not.toHaveBeenCalled();
  expect(f.execute).toHaveBeenCalledOnce();
});
it('keeps review handles revoked after permission regrant and refuses forged guard arguments', async () => {
  const f = fixture();
  await f.run(async () => {
    const review = f.port.prepareOperationReviewInScope('session', planned());
    f.authorize.mockReturnValue(false);
    expect(() =>
      Reflect.apply(review.assertCurrent, review, [{ tenant: 'owner', resource: 'draft' }])
    ).toThrow();
    f.authorize.mockReturnValue(true);
    expect(() => review.assertCurrent()).toThrow();
  });
});
it.each(['factory', 'consume', 'prepare'] as const)(
  'observes takeover from throwing %s callbacks and keeps failures undispatched',
  async (stage) => {
    const f = fixture(() => {
      if (stage === 'factory') {
        f.authority.takeover('session');
        throw new Error('PRIVATE factory');
      }
      return {
        assertCurrent() {},
        async consume() {
          f.authority.takeover('session');
          throw new Error('PRIVATE consume');
        },
      };
    });
    if (stage === 'prepare')
      f.parse.mockImplementation(() => {
        f.authority.takeover('session');
        throw new Error('PRIVATE prepare');
      });
    const result = await f.port
      .execute('session', operator, { ...planned(), approvalToken: 'token' })
      .catch((error) => error);
    expect(result).toHaveProperty('code');
    expect(String(result)).not.toContain('PRIVATE');
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.authority.get('session')?.operation('submit-1')).toMatchObject({
      dispatched: false,
      status: 'failed',
    });
  }
);
it('refuses a replaced binding after the final consent guard without another adapter callback', async () => {
  let consumed = false;
  const f = fixture(() => ({
    consume: async () => {
      consumed = true;
      return true;
    },
    assertCurrent() {
      if (!consumed) return;
      const bindings = (f.port as unknown as { bindings: WeakMap<object, object> }).bindings;
      const control = f.authority.get('session');
      assert(control);
      const old = bindings.get(control);
      assert(old);
      bindings.set(control, { ...old });
    },
  }));
  await expect(
    f.port.execute('session', operator, { ...planned(), approvalToken: 'token' })
  ).rejects.toThrow();
  expect(f.execute).not.toHaveBeenCalled();
});
it('requires a new operation ID after a failed attempt and never reconsumes on exact replay', async () => {
  const consume = vi.fn(async () => false);
  const f = fixture(() => ({ consume, assertCurrent() {} }));
  const request = { ...planned(), approvalToken: 'first' };
  await expect(f.port.execute('session', operator, request)).rejects.toThrow();
  consume.mockResolvedValue(true);
  await expect(f.port.execute('session', operator, request)).resolves.toMatchObject({
    replay: true,
    operation: { status: 'failed', dispatched: false },
  });
  await expect(
    f.port.execute('session', operator, { ...request, approvalToken: 'fresh' })
  ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  await f.port.execute('session', operator, {
    ...request,
    operationId: 'submit-2',
    approvalToken: 'fresh',
  });
  expect(consume).toHaveBeenCalledTimes(2);
  expect(f.execute).toHaveBeenCalledOnce();
});
it('competing exact requests consume once and return in-flight status for the second caller', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const consume = vi.fn(async () => {
    await pending;
    return true;
  });
  const f = fixture(() => ({ consume, assertCurrent() {} }));
  const request = { ...planned(), approvalToken: 'token' };
  const first = f.port.execute('session', operator, request);
  try {
    await expect(f.port.execute('session', operator, request)).resolves.toMatchObject({
      replay: true,
      operation: { status: 'in_flight', dispatched: false },
    });
    expect(f.execute).not.toHaveBeenCalled();
  } finally {
    finish();
  }
  await first;
  expect(consume).toHaveBeenCalledOnce();
  expect(f.execute).toHaveBeenCalledOnce();
});
it.each(['rejected', 'throw'] as const)(
  'preserves dispatched %s outcome without retrying consumption',
  async (mode) => {
    const consent = allowed();
    const f = fixture(() => consent);
    f.execute.mockImplementation(async () => {
      if (mode === 'throw') throw new Error('response lost');
      return { status: 'rejected', reason: 'VERSION_CONFLICT' } as never;
    });
    const request = { ...planned(), approvalToken: 'token' };
    const attempt = f.port.execute('session', operator, request);
    if (mode === 'throw') await expect(attempt).rejects.toThrow('response lost');
    else await expect(attempt).resolves.toMatchObject({ status: 'rejected' });
    await expect(f.port.execute('session', operator, request)).resolves.toMatchObject({
      replay: true,
      operation: { status: mode === 'throw' ? 'outcome_unknown' : 'failed', dispatched: true },
    });
    expect(consent.consume).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledOnce();
  }
);
it.each(['', 'x'.repeat(129), 1])(
  'refuses malformed token %s before preparation',
  async (approvalToken) => {
    const f = fixture(() => allowed());
    await expect(
      f.port.execute('session', operator, { ...planned(), approvalToken } as ApplicationRequest)
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(f.parse).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  }
);
