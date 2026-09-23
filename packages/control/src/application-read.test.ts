import { ControlError } from '@agentbrowser/core';
import { expect, it, vi } from 'vitest';
import {
  ApplicationAuthority,
  type ApplicationOperation,
  type ApplicationResult,
  type ApplicationScope,
} from './application-authority.js';
import { SessionAuthority } from './session-authority.js';

const principal = { actor: 'operator' as const, tenant: 'owner' };
const request = { operation: 'state', input: { key: 'pinned' } };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const authority = new SessionAuthority();
  const abort = new AbortController();
  authority.register('session', 'owner', abort.signal);
  const authorize = vi.fn(() => true);
  const execute = vi.fn(
    async (_scope: ApplicationScope): Promise<ApplicationResult> => ({
      status: 'read',
      value: { answer: 42 },
    })
  );
  const prepare = vi.fn((_input: unknown) => execute);
  const write = vi.fn((_input: unknown) => execute);
  const port = new ApplicationAuthority(authority, [
    {
      id: 'draft',
      authorize,
      operations: { state: { mode: 'read', prepare }, change: { mode: 'write', prepare: write } },
      receipt: async () => ({ legacy: true }),
    },
  ]);
  port.bind('session', principal, { adapter: 'draft', resource: 'one' });
  const run = <T>(callback: () => Promise<T> | T) =>
    authority.run('session', principal, {}, callback);
  return { authority, abort, authorize, execute, prepare, write, port, run };
}
it('pins immutable read identity and composes without a new admission or write', async () => {
  const s = setup();
  await s.run(async () => {
    const reader = s.port.prepareReadInScope('session', request);
    expect(reader.identity).toMatchObject({
      adapter: 'draft',
      resource: 'one',
      operation: 'state',
      sessionId: 'session',
      sessionIncarnation: s.authority.sessionIncarnation('session'),
    });
    expect(reader.identity.admission).toBe(s.authority.admissionInScope('session'));
    expect(Object.isFrozen(reader)).toBe(true);
    expect(Object.isFrozen(reader.identity)).toBe(true);
    expect(s.prepare).not.toHaveBeenCalled();
    expect(await reader.read()).toEqual({ answer: 42 });
    expect(s.authority.didDispatchInScope('session')).toBe(false);
  });
});
it.each([
  { operation: 'change', input: {} },
  { operation: 'missing', input: {} },
  { operation: 'toString', input: {} },
  { ...request, operationId: 'write' },
  { ...request, expectedVersion: 0 },
  { ...request, extra: 1 },
  { operation: 'state' },
  { operation: 'state', input: Number.NaN },
  { operation: 'state', input: 'x'.repeat(65537) },
  null,
  [],
])('refuses invalid requests before adapter preparation', async (input) => {
  const s = setup();
  await s.run(() => {
    expect(() => s.port.prepareReadInScope('session', input as typeof request)).toThrow();
  });
  expect(s.prepare).not.toHaveBeenCalled();
  expect(s.write).not.toHaveBeenCalled();
});
it('refuses missing and wrong admissions before preparation', async () => {
  const s = setup();
  expect(() => s.port.prepareReadInScope('session', request)).toThrow();
  s.authority.register('other', 'owner', new AbortController().signal);
  await s.run(() => {
    expect(() => s.port.prepareReadInScope('other', request)).toThrow();
  });
  expect(s.prepare).not.toHaveBeenCalled();
});
it('prepares fresh detached input and returns detached bounded output on every read', async () => {
  const s = setup();
  const input = { operation: 'state', input: { key: 'pinned' } };
  const output = { answer: { value: 42 } };
  s.execute.mockResolvedValue({ status: 'read', value: output });
  s.prepare.mockImplementation((value) => {
    expect(value).toEqual({ key: 'pinned' });
    (value as Record<string, unknown>).key = 'mutated';
    return s.execute;
  });
  await s.run(async () => {
    const reader = s.port.prepareReadInScope('session', input);
    input.input.key = 'changed';
    const first = (await reader.read()) as typeof output;
    first.answer.value = 9;
    expect(await reader.read()).toEqual(output);
    expect(s.prepare.mock.calls[0]?.[0]).not.toBe(s.prepare.mock.calls[1]?.[0]);
  });
});
it.each([null, 5, false, 'value'])('returns primitive JSON value %s', async (value) => {
  const s = setup();
  s.execute.mockResolvedValue({ status: 'read', value });
  expect(await s.run(() => s.port.prepareReadInScope('session', request).read())).toEqual(value);
});
it.each([
  { status: 'committed', value: 1 },
  { status: 'rejected', reason: 'PRIVATE' },
  { status: 'read' },
  { status: 'read', value: undefined },
  { status: 'read', value: Number.POSITIVE_INFINITY },
  { status: 'read', value: 'PRIVATE'.repeat(20000) },
  { status: 'read', value: 1, extra: 1 },
])('sanitizes malformed read results', async (result) => {
  const s = setup();
  s.execute.mockResolvedValue(result as ApplicationResult);
  const error = await s
    .run(() => s.port.prepareReadInScope('session', request).read())
    .catch((error) => error);
  expect(error).toMatchObject({
    code: 'INVALID_REQUEST',
    message: 'Invalid application read result',
  });
  expect(error.cause).toBeUndefined();
});
it.each(['prepare', 'execute'] as const)(
  'sanitizes %s callback errors including forged authority errors',
  async (stage) => {
    const s = setup();
    const error = new ControlError('CONTROL_REVOKED', 'PRIVATE');
    if (stage === 'prepare')
      s.prepare.mockImplementation(() => {
        throw error;
      });
    else s.execute.mockRejectedValue(error);
    const result = await s
      .run(() => s.port.prepareReadInScope('session', request).read())
      .catch((error) => error);
    expect(result).toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Application read callback failed',
    });
  }
);
it('rejects accessor results without invoking getters', async () => {
  const s = setup();
  const getter = vi.fn(() => 'read');
  s.execute.mockResolvedValue(
    Object.defineProperty({ value: 1 }, 'status', {
      enumerable: true,
      get: getter,
    }) as ApplicationResult
  );
  await expect(s.run(() => s.port.prepareReadInScope('session', request).read())).rejects.toThrow(
    'Invalid application read result'
  );
  expect(getter).not.toHaveBeenCalled();
});
it.each(['input', 'prepare', 'output'] as const)(
  'fences same-ID replacement during %s inspection',
  async (stage) => {
    const s = setup();
    const replace = () => {
      s.authority.remove('session');
      s.authority.register('session', 'owner', new AbortController().signal);
      s.port.bind('session', principal, { adapter: 'draft', resource: 'one' });
    };
    let input: unknown = request;
    if (stage === 'input')
      input = {
        operation: 'state',
        input: new Proxy(
          {},
          {
            ownKeys: () => {
              replace();
              return [];
            },
          }
        ),
      };
    if (stage === 'prepare')
      s.prepare.mockImplementation(() => {
        replace();
        return s.execute;
      });
    if (stage === 'output')
      s.execute.mockResolvedValue({
        status: 'read',
        value: new Proxy(
          {},
          {
            ownKeys: () => {
              replace();
              return [];
            },
          }
        ),
      });
    await expect(
      s.run(() => s.port.prepareReadInScope('session', input as typeof request).read())
    ).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
    expect(s.execute).toHaveBeenCalledTimes(stage === 'output' ? 1 : 0);
  }
);
it('withholds revoked reads and keeps permission loss sticky after regrant', async () => {
  const s = setup();
  await s.run(async () => {
    const reader = s.port.prepareReadInScope('session', request);
    s.authorize.mockReturnValue(false);
    expect(() => reader.assertAuthority()).toThrow();
    s.authorize.mockReturnValue(true);
    await expect(reader.read()).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  });
  expect(s.prepare).not.toHaveBeenCalled();
});
it('rejects already aborted signals before preparation and withholds cancelled async results', async () => {
  const s = setup();
  const cancel = new AbortController();
  await s.run(async () => {
    const reader = s.port.prepareReadInScope('session', request);
    cancel.abort();
    await expect(reader.read(cancel.signal)).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  });
  expect(s.prepare).not.toHaveBeenCalled();
  const t = setup();
  const stop = new AbortController();
  const ready = deferred();
  t.execute.mockImplementation(async (scope) => {
    await ready.promise;
    expect(scope.signal.aborted).toBe(true);
    return { status: 'read', value: 'PRIVATE' };
  });
  await t.run(async () => {
    const pending = t.port.prepareReadInScope('session', request).read(stop.signal);
    const refused = expect(pending).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
    stop.abort();
    ready.resolve();
    await refused;
  });
});
it('drains unawaited reads and refuses their late output after admission closes', async () => {
  const s = setup();
  const release = deferred();
  s.execute.mockImplementation(async () => {
    await release.promise;
    return { status: 'read', value: 'PRIVATE' };
  });
  let pending: Promise<unknown> | undefined;
  await s.run(() => {
    pending = s.port.prepareReadInScope('session', request).read();
  });
  expect(s.authority.get('session')?.view().busy).toBe(true);
  const refused = expect(pending).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  release.resolve();
  await refused;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(s.authority.get('session')?.view().busy).toBe(false);
});
it('refuses reader reuse outside a completed admission', async () => {
  const s = setup();
  const reader = await s.run(() => s.port.prepareReadInScope('session', request));
  await expect(reader.read()).rejects.toThrow();
  expect(s.prepare).not.toHaveBeenCalled();
});

it('does not invoke any adapter callback for an already cancelled read', async () => {
  const s = setup();
  await s.run(async () => {
    const reader = s.port.prepareReadInScope('session', request);
    s.authorize.mockClear();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(reader.read(cancelled.signal)).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
    expect(s.authorize).not.toHaveBeenCalled();
    expect(s.prepare).not.toHaveBeenCalled();
  });
});
it.each(['prepare', 'execute'] as const)(
  'gives real revocation precedence over a failing %s callback',
  async (stage) => {
    const s = setup();
    const fail = () => {
      s.authority.takeover('session');
      throw new ControlError('INVALID_REQUEST', 'PRIVATE');
    };
    if (stage === 'prepare') s.prepare.mockImplementation(fail);
    else s.execute.mockImplementation(async () => fail());
    await expect(
      s.run(() => s.port.prepareReadInScope('session', request).read())
    ).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
  }
);
it('does not revive an in-flight read after observed policy denial and regrant', async () => {
  const s = setup();
  const release = deferred();
  s.execute.mockImplementation(async () => {
    await release.promise;
    return { status: 'read', value: 'PRIVATE' };
  });
  await s.run(async () => {
    const reader = s.port.prepareReadInScope('session', request);
    const pending = reader.read();
    const refused = expect(pending).rejects.toMatchObject({ code: 'CONTROL_REVOKED' });
    s.authorize.mockReturnValue(false);
    expect(() => reader.assertAuthority()).toThrow();
    s.authorize.mockReturnValue(true);
    release.resolve();
    await refused;
  });
});
it('rejects symbols, hidden fields and array extras rather than silently dropping them', async () => {
  const s = setup();
  const symbol = { ...request, [Symbol('extra')]: 'PRIVATE' };
  const hidden = Object.defineProperty({ ...request }, 'extra', { value: 'PRIVATE' });
  const array = Object.assign([1], { extra: 'PRIVATE' });
  await s.run(() => {
    for (const input of [symbol, hidden, { operation: 'state', input: array }])
      expect(() => s.port.prepareReadInScope('session', input)).toThrow(
        'Invalid application read request'
      );
  });
  expect(s.prepare).not.toHaveBeenCalled();
});
it('rejects malformed and asynchronous preparation results before execution', async () => {
  const s = setup();
  await s.run(async () => {
    for (const prepare of [() => null, () => Promise.reject(new Error('PRIVATE'))]) {
      s.prepare.mockImplementation(prepare as ApplicationOperation['prepare']);
      await expect(s.port.prepareReadInScope('session', request).read()).rejects.toThrow(
        'Application read callback failed'
      );
    }
  });
  expect(s.execute).not.toHaveBeenCalled();
});

it.each(['read', 'receipt'] as const)(
  'does not let public %s authority assertion replace the captured scope',
  async (kind) => {
    const s = setup();
    await s.run(() => {
      const reader =
        kind === 'read'
          ? s.port.prepareReadInScope('session', request)
          : s.port.prepareReceiptReadInScope('session');
      s.authorize.mockImplementation(
        ((scope: { resource: string }) => scope.resource === 'forged') as () => boolean
      );
      const invoke = reader.assertAuthority as unknown as (scope: ApplicationScope) => void;
      expect(() =>
        invoke({
          sessionId: 'session',
          sessionIncarnation: s.authority.sessionIncarnation('session'),
          tenant: 'owner',
          resource: 'forged',
          signal: new AbortController().signal,
        })
      ).toThrow();
    });
  }
);
