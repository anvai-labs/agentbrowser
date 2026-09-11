import { describe, expect, it } from 'vitest';
import { EngineError, normalizeEngineError } from './errors.js';

describe('adapter error normalization', () => {
  it.each(['navigate', 'act', 'observe', 'screenshot', 'pdf'])(
    'preserves typed semantics for %s without parsing prose',
    (operation) => {
      expect(
        normalizeEngineError(
          new EngineError('ENGINE_CRASHED', 'opaque diagnostic', false, { reason: 'transport' }),
          operation
        )
      ).toMatchObject({ code: 'ENGINE_CRASHED', details: { reason: 'transport' } });
      expect(
        normalizeEngineError(
          new EngineError('POLICY_DENIED', 'timeout is not the cause'),
          operation
        ).code
      ).toBe('POLICY_DENIED');
    }
  );
  it('classifies legacy timeout by operation without promising safe mutation retries', () => {
    expect(normalizeEngineError(new Error('Timeout 100ms'), 'navigate')).toMatchObject({
      code: 'NAVIGATION_TIMEOUT',
      retryable: false,
    });
    expect(normalizeEngineError(new Error('Timeout 100ms'), 'act')).toMatchObject({
      code: 'ACTION_TIMEOUT',
      retryable: false,
    });
  });
  it('maps the non-file-input setInputFiles refusal to INVALID_REQUEST', () => {
    const message = "File input element is not an <input type='file'> - check the element type";
    expect(normalizeEngineError(new Error(message), 'act')).toMatchObject({
      code: 'INVALID_REQUEST',
      retryable: false,
    });
  });
});
