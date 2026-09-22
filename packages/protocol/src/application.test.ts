import { describe, expect, it, vi } from 'vitest';
import {
  validateApplicationBinding,
  validateApplicationExecute,
  validateApplicationOperationDescriptors,
  validateApplicationReview,
} from './application.js';

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

describe('application review wire contracts', () => {
  const request = () => ({
    pageId: 'page-1',
    source: { ownerId: 'owner-1', contract: { id: 'draft', version: 'v1' } },
    request: {
      operation: 'submit',
      input: { private: 'answer' },
      operationId: 'future-1',
      expectedVersion: 1,
    },
  });
  it('accepts only explicit complete planned identities and bounded source hints', () => {
    expect(validateApplicationReview(request()).ok).toBe(true);
    expect(
      validateApplicationReview({
        ...request(),
        source: {
          ownerId: 'owner-1',
          contract: { id: 'native-form.witness', version: '1.0.0' },
        },
      }).ok
    ).toBe(true);
    for (const value of [
      { ...request(), decision: 'approve' },
      { ...request(), source: { ...request().source, permission: true } },
      { ...request(), request: { ...request().request, approvalToken: 'token' } },
      { ...request(), request: { operation: 'submit', input: null } },
      { ...request(), source: { ownerId: 'x'.repeat(256), contract: request().source.contract } },
      { ...request(), pageId: '' },
      {
        ...request(),
        request: { ...request().request, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
      },
    ])
      expect(validateApplicationReview(value).ok).toBe(false);
  });
  it('projects immutable review requirements and bounds optional execution credentials', () => {
    expect(
      validateApplicationOperationDescriptors([
        { name: 'submit', mode: 'write', review: 'operator-submit' },
      ]).ok
    ).toBe(true);
    expect(
      validateApplicationOperationDescriptors([{ name: 'submit', mode: 'write', review: 'other' }])
        .ok
    ).toBe(false);
    expect(validateApplicationExecute({ ...request().request, approvalToken: 'token' }).ok).toBe(
      true
    );
    for (const approvalToken of ['', 'x'.repeat(129), 1])
      expect(validateApplicationExecute({ ...request().request, approvalToken }).ok).toBe(false);
  });
  it('detaches nested creation data and refuses accessors or hidden data without invoking them', () => {
    const body = request();
    const checked = validateApplicationReview(body);
    body.request.input.private = 'changed';
    expect(checked.ok && checked.value.request.input).toEqual({ private: 'answer' });
    const getter = vi.fn(() => 'submit');
    const accessor = request();
    Object.defineProperty(accessor.request, 'operation', { get: getter });
    expect(validateApplicationReview(accessor).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(
      validateApplicationReview(Object.defineProperty(request(), 'hidden', { value: 1 })).ok
    ).toBe(false);
    expect(
      validateApplicationReview({
        ...request(),
        request: { ...request().request, input: 'x'.repeat(70_000) },
      }).ok
    ).toBe(false);
  });
});
