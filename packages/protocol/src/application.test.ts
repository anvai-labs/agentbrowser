import { describe, expect, it } from 'vitest';
import { validateApplicationBinding, validateApplicationExecute } from './application.js';

describe('application wire validators', () => {
  describe('validateApplicationBinding', () => {
    it('accepts an adapter and resource in the control identifier space', () => {
      const result = validateApplicationBinding({ adapter: 'owned-counter', resource: 'account' });
      expect(result).toEqual({
        ok: true,
        value: { adapter: 'owned-counter', resource: 'account' },
      });
    });

    it('rejects missing or non-string fields', () => {
      expect(validateApplicationBinding({ adapter: 'owned-counter' }).ok).toBe(false);
      expect(validateApplicationBinding({ resource: 'account' }).ok).toBe(false);
      expect(validateApplicationBinding({ adapter: 7, resource: 'account' }).ok).toBe(false);
      expect(validateApplicationBinding('bind').ok).toBe(false);
    });

    it('rejects identifiers outside the operation-ID space or additional properties', () => {
      expect(validateApplicationBinding({ adapter: 'bad id!', resource: 'account' }).ok).toBe(
        false
      );
      expect(validateApplicationBinding({ adapter: 'a'.repeat(129), resource: 'r' }).ok).toBe(
        false
      );
      expect(validateApplicationBinding({ adapter: 'a', resource: 'r', extra: true }).ok).toBe(
        false
      );
    });
  });

  describe('validateApplicationExecute', () => {
    it('accepts a read request with input only', () => {
      const result = validateApplicationExecute({ operation: 'balance', input: { id: 'a1' } });
      expect(result).toEqual({ ok: true, value: { operation: 'balance', input: { id: 'a1' } } });
    });

    it('accepts a write request with both identities', () => {
      const result = validateApplicationExecute({
        operation: 'add',
        input: 1,
        operationId: 'effect-1',
        expectedVersion: 0,
      });
      expect(result.ok).toBe(true);
    });

    it('accepts every JSON value shape as input', () => {
      for (const input of [null, 1, 'text', true, [], { a: [1, { b: null }] }]) {
        expect(validateApplicationExecute({ operation: 'op', input }).ok).toBe(true);
      }
    });

    it('rejects a missing operation, unknown fields, or bad identities', () => {
      expect(validateApplicationExecute({ input: 1 }).ok).toBe(false);
      expect(validateApplicationExecute({ operation: 'add' }).ok).toBe(false);
      expect(validateApplicationExecute({ operation: 'add', input: 1, extra: 1 }).ok).toBe(false);
      expect(
        validateApplicationExecute({ operation: 'add', input: 1, operationId: 'bad id' }).ok
      ).toBe(false);
      expect(
        validateApplicationExecute({ operation: 'add', input: 1, expectedVersion: -1 }).ok
      ).toBe(false);
    });

    it('does not bind input size here - the authority owns canonicalJson bounds', () => {
      // 200 KB of input passes the shape check; the authority's canonicalJson
      // admission (64 KiB) rejects it with INVALID_REQUEST at execution.
      const result = validateApplicationExecute({
        operation: 'add',
        input: 'x'.repeat(200_000),
      });
      expect(result.ok).toBe(true);
    });
  });
});
