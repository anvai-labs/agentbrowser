/**
 * T4 A1: an adapter may declare `parseOutput`; a result that does not match it is a typed
 * failure, never a success. For a write the effect has already run, so the failure is recorded
 * as dispatched (reconcile by receipt) and a retry with the same operation ID never re-executes.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApplicationAuthority, defineApplicationOperation } from './application-authority.js';
import { SessionAuthority } from './session-authority.js';

const operator = { actor: 'operator', tenant: 'owner' } as const;
const binding = { adapter: 'shop', resource: 'cart' };

function setup(output: unknown) {
  const authority = new SessionAuthority();
  authority.register('session', 'owner', new AbortController().signal);
  const parseOutput = vi.fn((value: unknown) => {
    const v = value as { total?: unknown };
    if (typeof value !== 'object' || value === null || typeof v.total !== 'number')
      throw new Error('PRIVATE-OUTPUT-DETAIL');
    return { total: v.total };
  });
  const effect = vi.fn(async () => ({ status: 'committed' as const, value: output }));
  const port = new ApplicationAuthority(authority, [
    {
      id: 'shop',
      authorize: () => true,
      operations: {
        add: defineApplicationOperation({
          mode: 'write',
          parse: (input: unknown) => Number(input),
          execute: effect,
          parseOutput,
        }),
        total: defineApplicationOperation({
          mode: 'read',
          parse: () => undefined,
          execute: async () => ({ status: 'read' as const, value: output }),
          parseOutput,
        }),
        legacy: defineApplicationOperation({
          mode: 'read',
          parse: () => undefined,
          execute: async () => ({ status: 'read' as const, value: output }),
        }),
      },
      receipt: async () => ({ verification: 'unknown' }),
    },
  ]);
  port.bind('session', operator, binding);
  return { authority, port, effect, parseOutput };
}

describe('declared adapter output (parseOutput)', () => {
  it('a matching result passes and is replaced by the parsed value', async () => {
    const s = setup({ total: 3, extra: 'dropped by the parser' });
    expect(await s.port.execute('session', operator, { operation: 'total', input: null })).toEqual(
      expect.objectContaining({ status: 'read', value: { total: 3 } })
    );
  });

  it('a mismatched read is a typed failure that does not echo the adapter output or parser text', async () => {
    const s = setup({ total: 'PRIVATE-VALUE' });
    const error = await s.port
      .execute('session', operator, { operation: 'total', input: null })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'INVALID_REQUEST', message: 'Invalid application output' });
    expect(String((error as Error).message)).not.toMatch(/PRIVATE/);
  });

  it('a mismatched write is recorded dispatched with an unknown outcome, never committed, and its retry does not re-run the effect', async () => {
    const s = setup({ wrong: true });
    const request = { operation: 'add', input: 1, operationId: 'write-1', expectedVersion: 0 };
    await expect(s.port.execute('session', operator, request)).rejects.toMatchObject({
      message: 'Invalid application output',
    });
    expect(s.effect).toHaveBeenCalledTimes(1);
    const record = s.authority.get('session')!.operation('write-1');
    expect(record).toMatchObject({ dispatched: true });
    expect(record?.status).not.toBe('committed');
    expect(record?.status).toBe('outcome_unknown');
    // The same operation ID is never executed again.
    await s.port.execute('session', operator, request).catch(() => undefined);
    expect(s.effect).toHaveBeenCalledTimes(1);
  });

  it('operations without parseOutput keep their existing behaviour', async () => {
    const s = setup({ anything: ['goes'] });
    expect(await s.port.execute('session', operator, { operation: 'legacy', input: null })).toEqual(
      expect.objectContaining({ status: 'read', value: { anything: ['goes'] } })
    );
    expect(s.parseOutput).not.toHaveBeenCalled();
  });

  it('a rejected result is not passed to parseOutput', async () => {
    const authority = new SessionAuthority();
    authority.register('session', 'owner', new AbortController().signal);
    const parseOutput = vi.fn();
    const port = new ApplicationAuthority(authority, [
      {
        id: 'shop',
        authorize: () => true,
        operations: {
          add: defineApplicationOperation({
            mode: 'write',
            parse: (input: unknown) => input,
            execute: async () => ({ status: 'rejected' as const, reason: 'OUT_OF_STOCK' }),
            parseOutput,
          }),
        },
        receipt: async () => ({}),
      },
    ]);
    port.bind('session', operator, binding);
    expect(
      await port.execute('session', operator, {
        operation: 'add',
        input: 1,
        operationId: 'w',
        expectedVersion: 0,
      })
    ).toMatchObject({ status: 'rejected', reason: 'OUT_OF_STOCK' });
    expect(parseOutput).not.toHaveBeenCalled();
  });

  it('a prepared read with a mismatched output fails instead of returning data', async () => {
    const s = setup({ total: 'PRIVATE-VALUE' });
    await expect(
      s.authority.run('session', operator, {}, async () => {
        const reader = s.port.prepareReadInScope('session', { operation: 'total', input: null });
        return reader.read();
      })
    ).rejects.toThrow(/^(Invalid application output|Application read callback failed)$/);
  });
});
