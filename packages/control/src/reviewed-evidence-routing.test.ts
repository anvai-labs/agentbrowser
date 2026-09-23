import { expect, it, vi } from 'vitest';
import {
  NATIVE_FORM_REVIEW_TYPE,
  captureEvidenceReviewSource,
  selectApplicationReview,
  selectEvidenceReview,
} from './reviewed-evidence.js';

const action = () => ({
  type: 'application-submit',
  intent: 'submit',
  tenant: 'tenant-1',
  sessionId: 'session-1',
  sessionIncarnation: 'incarnation-1',
  adapter: 'draft',
  resource: 'candidate',
  bindingGeneration: 'generation-1',
  operation: 'submit',
  operationId: 'future-1',
  expectedVersion: 2,
  input: { answer: 'PRIVATE' },
});
const source = () => ({
  ownerId: 'owner-1',
  contract: { id: 'draft', version: 'v1' },
  permission: {
    generation: 1,
    currentGeneration() {
      return this.generation;
    },
  },
  assertAuthorized() {
    expect(this.ownerId).toBe('owner-1');
  },
  collect() {
    return { ownerId: this.ownerId };
  },
});
it('routes two intended operations under one source owner without projecting private data', () => {
  const stored = (operationId: string) => ({
    type: NATIVE_FORM_REVIEW_TYPE,
    pageId: 'page-1',
    parameters: {
      action: { ...action(), operationId },
      source: {
        ownerId: 'owner-1',
        contract: { id: 'draft', version: 'v1' },
        permissionGeneration: 1,
      },
      witness: { private: 'PRIVATE-WITNESS' },
    },
  });
  const first = selectEvidenceReview(stored('future-1'));
  const second = selectEvidenceReview(stored('future-2'));
  expect(first?.application).toEqual({
    adapter: 'draft',
    resource: 'candidate',
    bindingGeneration: 'generation-1',
    operation: 'submit',
    operationId: 'future-1',
    expectedVersion: 2,
  });
  expect(second?.application?.operationId).toBe('future-2');
  expect(first?.source).toEqual(second?.source);
  expect(JSON.stringify(first)).not.toContain('PRIVATE');
  expect(Object.isFrozen(first?.application)).toBe(true);
});
it('preserves generic routing and refuses malformed reserved application actions', () => {
  expect(selectApplicationReview({ type: 'draft', input: 'private' })).toBeUndefined();
  for (const value of [
    { ...action(), intent: 'draft' },
    { ...action(), operationId: 'bad id' },
    { ...action(), expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...action(), bindingGeneration: '' },
    { ...action(), extra: 'PRIVATE' },
  ])
    expect(() => selectApplicationReview(value)).toThrow('Evidence review unavailable');
  const getter = vi.fn(() => 'PRIVATE');
  expect(() =>
    selectApplicationReview(Object.defineProperty(action(), 'input', { get: getter }))
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const stored = {
    type: NATIVE_FORM_REVIEW_TYPE,
    pageId: 'page-1',
    parameters: {
      action: { ...action(), operationId: '' },
      witness: {},
      source: {
        ownerId: 'owner-1',
        contract: { id: 'draft', version: 'v1' },
        permissionGeneration: 1,
      },
    },
  };
  expect(selectEvidenceReview(stored)).toBeUndefined();
});
it('refuses a reserved action whose discriminator changes while its snapshot is captured', () => {
  let first = true;
  const mutable = action();
  const proxy = new Proxy(mutable, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key === 'type' && first) {
        first = false;
        target.type = 'draft';
      }
      return descriptor;
    },
  });
  expect(() => selectApplicationReview(proxy)).toThrow('Evidence review unavailable');
});
it('captures source metadata and callbacks once while preserving original receivers', () => {
  const original = source();
  const captured = captureEvidenceReviewSource(original);
  original.contract.id = 'replaced';
  original.collect = vi.fn(() => {
    throw new Error('replaced');
  });
  original.assertAuthorized = vi.fn(() => {
    throw new Error('replaced');
  });
  original.permission.currentGeneration = vi.fn(() => 99);
  expect(captured.contract.id).toBe('draft');
  captured.assertAuthorized();
  expect(captured.collect(new AbortController().signal)).toEqual({ ownerId: 'owner-1' });
  expect(captured.permission.currentGeneration()).toBe(1);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(Object.isFrozen(captured.contract)).toBe(true);
  original.permission.generation = 2;
  expect(() => captured.permission.currentGeneration()).toThrow();
  original.permission.generation = 1;
  expect(() => captured.permission.currentGeneration()).toThrow();
});
it('rejects source accessors, hidden fields and malformed permissions without private errors', () => {
  const getter = vi.fn(() => 'PRIVATE');
  for (const value of [
    Object.defineProperty(source(), 'ownerId', { get: getter }),
    Object.defineProperty(source(), 'extra', { value: 'PRIVATE' }),
    { ...source(), permission: { generation: 1, currentGeneration: async () => 1 } },
  ])
    expect(() => captureEvidenceReviewSource(value)).toThrow('Evidence review unavailable');
  expect(getter).not.toHaveBeenCalled();
});
