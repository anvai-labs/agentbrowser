/**
 * TDD Tests for Protocol Error Handling
 *
 * Following TDD principles, these tests are written first to define
 * the expected behavior of error handling in the protocol.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, createApiError, createApiErrorDetail, isApiError } from './errors';
import type { ApiErrorDetail } from './errors';

describe('Error Codes', () => {
  it('should have all required error codes', () => {
    // Core request/response errors
    expect(ErrorCode.INVALID_REQUEST).toBe('INVALID_REQUEST');
    expect(ErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ErrorCode.FORBIDDEN).toBe('FORBIDDEN');
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');

    // Policy and approval errors
    expect(ErrorCode.POLICY_DENIED).toBe('POLICY_DENIED');
    expect(ErrorCode.APPROVAL_REQUIRED).toBe('APPROVAL_REQUIRED');

    // Session errors
    expect(ErrorCode.SESSION_NOT_FOUND).toBe('SESSION_NOT_FOUND');
    expect(ErrorCode.SESSION_EXPIRED).toBe('SESSION_EXPIRED');

    // Page errors
    expect(ErrorCode.PAGE_NOT_FOUND).toBe('PAGE_NOT_FOUND');

    // Element reference errors
    expect(ErrorCode.STALE_TARGET).toBe('STALE_TARGET');
    expect(ErrorCode.TARGET_NOT_FOUND).toBe('TARGET_NOT_FOUND');
    expect(ErrorCode.TARGET_AMBIGUOUS).toBe('TARGET_AMBIGUOUS');
    expect(ErrorCode.TARGET_NOT_VISIBLE).toBe('TARGET_NOT_VISIBLE');
    expect(ErrorCode.TARGET_DISABLED).toBe('TARGET_DISABLED');

    // Navigation and action errors
    expect(ErrorCode.NAVIGATION_TIMEOUT).toBe('NAVIGATION_TIMEOUT');
    expect(ErrorCode.ACTION_TIMEOUT).toBe('ACTION_TIMEOUT');

    // Engine errors
    expect(ErrorCode.ENGINE_UNSUPPORTED).toBe('ENGINE_UNSUPPORTED');
    expect(ErrorCode.ENGINE_CRASHED).toBe('ENGINE_CRASHED');

    // Resource and quota errors
    expect(ErrorCode.DOWNLOAD_BLOCKED).toBe('DOWNLOAD_BLOCKED');
    expect(ErrorCode.QUOTA_EXCEEDED).toBe('QUOTA_EXCEEDED');

    // Output errors
    expect(ErrorCode.OUTPUT_TRUNCATED).toBe('OUTPUT_TRUNCATED');

    // Internal errors
    expect(ErrorCode.INTERNAL).toBe('INTERNAL');
  });

  it('should have unique error codes', () => {
    const values = Object.values(ErrorCode);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });
});

describe('createApiError', () => {
  it('should create basic error envelope', () => {
    const error = createApiError(ErrorCode.INVALID_REQUEST, 'Invalid parameter');

    expect(error).toEqual({
      error: {
        code: ErrorCode.INVALID_REQUEST,
        message: 'Invalid parameter',
        retryable: false,
      },
    });
  });

  it('should create error with all options', () => {
    const error = createApiError(ErrorCode.STALE_TARGET, 'Element is stale', {
      retryable: true,
      action: 'observe_and_retry',
      details: { expectedRevision: 5, actualRevision: 7 },
      traceId: 'trace_123',
    });

    expect(error.error).toMatchObject({
      code: ErrorCode.STALE_TARGET,
      message: 'Element is stale',
      retryable: true,
      action: 'observe_and_retry',
      details: { expectedRevision: 5, actualRevision: 7 },
      traceId: 'trace_123',
    });
  });

  it('should default retryable to false', () => {
    const error = createApiError(ErrorCode.INTERNAL, 'Internal error');

    expect(error.error.retryable).toBe(false);
  });

  it('should allow retryable to be set to true', () => {
    const error = createApiError(ErrorCode.NAVIGATION_TIMEOUT, 'Timeout', {
      retryable: true,
    });

    expect(error.error.retryable).toBe(true);
  });

  it('should handle empty options', () => {
    const error = createApiError(ErrorCode.SESSION_NOT_FOUND, 'Not found', {});

    expect(error.error).toMatchObject({
      code: ErrorCode.SESSION_NOT_FOUND,
      message: 'Not found',
      retryable: false,
    });
    expect(error.error.action).toBeUndefined();
    expect(error.error.details).toBeUndefined();
    expect(error.error.traceId).toBeUndefined();
  });
});

describe('isApiError', () => {
  it('should return true for valid API error', () => {
    const error = {
      error: {
        code: ErrorCode.INVALID_REQUEST,
        message: 'Invalid',
        retryable: false,
      },
    };

    expect(isApiError(error)).toBe(true);
  });

  it('should return false for non-error objects', () => {
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
    expect(isApiError({})).toBe(false);
    expect(isApiError({ data: 'value' })).toBe(false);
  });

  it('should return false for malformed error', () => {
    const malformedError = {
      error: 'not an object',
    };

    expect(isApiError(malformedError)).toBe(false);
  });

  it('should return false for error without code', () => {
    const errorWithoutCode = {
      error: {
        message: 'Error message',
      },
    };

    expect(isApiError(errorWithoutCode)).toBe(false);
  });

  it('should return false for primitives', () => {
    expect(isApiError('error string')).toBe(false);
    expect(isApiError(123)).toBe(false);
    expect(isApiError(true)).toBe(false);
  });
});

describe('Error Envelope Structure', () => {
  it('should have required fields in error object', () => {
    const error = createApiError(ErrorCode.POLICY_DENIED, 'Access denied');

    expect(error.error).toHaveProperty('code');
    expect(error.error).toHaveProperty('message');
    expect(error.error).toHaveProperty('retryable');
    expect(typeof error.error.code).toBe('string');
    expect(typeof error.error.message).toBe('string');
    expect(typeof error.error.retryable).toBe('boolean');
  });

  it('should have optional fields only when provided', () => {
    const errorWithoutOptions = createApiError(ErrorCode.QUOTA_EXCEEDED, 'Quota exceeded');
    const errorWithOptions = createApiError(ErrorCode.QUOTA_EXCEEDED, 'Quota exceeded', {
      action: 'upgrade_plan',
      details: { current: 100, limit: 100 },
    });

    expect(errorWithoutOptions.error.action).toBeUndefined();
    expect(errorWithOptions.error.action).toBeDefined();
    expect(errorWithOptions.error.details).toBeDefined();
  });
});

describe('Common Error Patterns', () => {
  it('should create STALE_TARGET error correctly', () => {
    const error = createApiError(
      ErrorCode.STALE_TARGET,
      'Element reference belongs to revision 17; page is at revision 19',
      {
        retryable: true,
        action: 'observe_and_retry',
        details: { expectedRevision: 17, actualRevision: 19 },
      }
    );

    expect(error.error.code).toBe(ErrorCode.STALE_TARGET);
    expect(error.error.retryable).toBe(true);
    expect(error.error.action).toBe('observe_and_retry');
  });

  it('should create POLICY_DENIED error correctly', () => {
    const error = createApiError(
      ErrorCode.POLICY_DENIED,
      'Access to localhost is blocked by policy',
      {
        retryable: false,
        details: { hostname: 'localhost', reason: 'loopback_blocked' },
      }
    );

    expect(error.error.code).toBe(ErrorCode.POLICY_DENIED);
    expect(error.error.retryable).toBe(false);
  });

  it('should create APPROVAL_REQUIRED error correctly', () => {
    const error = createApiError(ErrorCode.APPROVAL_REQUIRED, 'Action requires approval', {
      retryable: false,
      action: 'request_approval',
      details: {
        effect: 'transaction',
        action: 'click',
        target: 'e17_09',
      },
    });

    expect(error.error.code).toBe(ErrorCode.APPROVAL_REQUIRED);
    expect(error.error.details?.effect).toBe('transaction');
  });

  it('should create SESSION_EXPIRED error correctly', () => {
    const error = createApiError(ErrorCode.SESSION_EXPIRED, 'Session TTL exceeded', {
      retryable: false,
      details: { sessionId: 'ses_01', ttlMs: 900000, elapsedMs: 950000 },
    });

    expect(error.error.code).toBe(ErrorCode.SESSION_EXPIRED);
    expect(error.error.retryable).toBe(false);
  });
});

describe('ApiErrorDetail', () => {
  it('should create a bare error detail without the envelope', () => {
    const detail = createApiErrorDetail(ErrorCode.STALE_TARGET, 'Element is stale', {
      retryable: true,
      details: { ref: 'e17_09', expectedRevision: 17, currentRevision: 18 },
    });

    expect(detail.code).toBe(ErrorCode.STALE_TARGET);
    expect(detail.message).toBe('Element is stale');
    expect(detail.retryable).toBe(true);
    expect(detail.details?.ref).toBe('e17_09');
    // A detail is NOT an envelope - it must not nest itself
    expect('error' in detail).toBe(false);
  });

  it('should default retryable to false', () => {
    const detail = createApiErrorDetail(ErrorCode.TARGET_DISABLED, 'Target is disabled');
    expect(detail.retryable).toBe(false);
  });

  it('should omit optional fields that were not provided', () => {
    const detail = createApiErrorDetail(ErrorCode.INTERNAL, 'boom');
    expect(detail.action).toBeUndefined();
    expect(detail.details).toBeUndefined();
    expect(detail.traceId).toBeUndefined();
  });

  it('should be the payload wrapped by createApiError', () => {
    const detail: ApiErrorDetail = createApiErrorDetail(ErrorCode.POLICY_DENIED, 'denied', {
      retryable: false,
    });
    const envelope = createApiError(ErrorCode.POLICY_DENIED, 'denied', { retryable: false });

    expect(envelope.error).toEqual(detail);
    expect(isApiError({ error: detail })).toBe(true);
  });
});
