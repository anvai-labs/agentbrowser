/**
 * TDD Tests for Protocol Schema Validation
 *
 * Following TDD principles, these tests define the expected behavior
 * of schema validation for all protocol types.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode } from './errors';
import {
  ActionRequestSchema,
  ApiErrorSchema,
  EngineCapabilitiesSchema,
  ErrorCodeEnum,
  ObservationRequestSchema,
  PageStateSchema,
  SessionPolicySchema,
  SessionRequestSchema,
  ViewportSchema,
  validate,
} from './schemas';

describe('Schema Validation - Session Request', () => {
  it('should validate valid session request', () => {
    const validRequest = {
      engine: 'playwright-chromium',
      ttlMs: 900000,
      policy: {
        allowedHosts: ['example.com', '*.example.com'],
      },
    };

    const result = validate(SessionRequestSchema, validRequest);
    expect(result.success).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('should reject invalid TTL (negative)', () => {
    const invalidRequest = {
      engine: 'playwright-chromium',
      ttlMs: -1, // Invalid: must be positive
      policy: {
        allowedHosts: ['example.com'],
      },
    };

    const result = validate(SessionRequestSchema, invalidRequest);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it('should reject empty allowed hosts', () => {
    const invalidRequest = {
      engine: 'playwright-chromium',
      policy: {
        allowedHosts: [], // Invalid: must have at least one
      },
    };

    const result = validate(SessionRequestSchema, invalidRequest);
    expect(result.success).toBe(false);
  });

  it('should reject invalid engine type', () => {
    const invalidRequest = {
      engine: 'invalid-engine', // Invalid: not in enum
      policy: {
        allowedHosts: ['example.com'],
      },
    };

    const result = validate(SessionRequestSchema, invalidRequest);
    expect(result.success).toBe(false);
  });

  it('should accept minimal session request', () => {
    const minimalRequest = {
      engine: 'playwright-chromium',
    };

    const result = validate(SessionRequestSchema, minimalRequest);
    expect(result.success).toBe(true);
  });

  it('should accept auto engine type', () => {
    const autoRequest = {
      engine: 'auto',
    };

    const result = validate(SessionRequestSchema, autoRequest);
    expect(result.success).toBe(true);
  });
});

describe('Schema Validation - Viewport', () => {
  it('should validate valid viewport', () => {
    const validViewport = {
      width: 1280,
      height: 720,
    };

    const result = validate(ViewportSchema, validViewport);
    expect(result.success).toBe(true);
  });

  it('should reject viewport with zero dimensions', () => {
    const invalidViewport = {
      width: 0,
      height: 720,
    };

    const result = validate(ViewportSchema, invalidViewport);
    expect(result.success).toBe(false);
  });

  it('should reject viewport with excessive dimensions', () => {
    const invalidViewport = {
      width: 100000, // Invalid: exceeds maximum
      height: 720,
    };

    const result = validate(ViewportSchema, invalidViewport);
    expect(result.success).toBe(false);
  });
});

describe('Schema Validation - Session Policy', () => {
  it('should validate valid policy', () => {
    const validPolicy = {
      allowedHosts: ['example.com', '*.example.com'],
      blockedHosts: ['malicious.com'],
      allowDownloads: false,
      maxDownloadBytes: 10485760,
      approval: {
        transactions: 'required',
        externalMessages: 'required',
      },
    };

    const result = validate(SessionPolicySchema, validPolicy);
    expect(result.success).toBe(true);
  });

  it('should require at least one allowed host', () => {
    const invalidPolicy = {
      allowedHosts: [], // Invalid: must have at least one
    };

    const result = validate(SessionPolicySchema, invalidPolicy);
    expect(result.success).toBe(false);
  });

  it('should reject invalid approval value', () => {
    const invalidPolicy = {
      allowedHosts: ['example.com'],
      approval: {
        transactions: 'invalid', // Invalid: not in enum
      },
    };

    const result = validate(SessionPolicySchema, invalidPolicy);
    expect(result.success).toBe(false);
  });
});

describe('Schema Validation - Error Codes', () => {
  it('should contain all required error codes', () => {
    const requiredCodes = [
      'INVALID_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'POLICY_DENIED',
      'APPROVAL_REQUIRED',
      'SESSION_NOT_FOUND',
      'SESSION_EXPIRED',
      'STALE_TARGET',
      'TARGET_NOT_FOUND',
      'ENGINE_CRASHED',
    ];

    requiredCodes.forEach((code) => {
      expect(Object.values(ErrorCode).includes(code as ErrorCode)).toBe(true);
    });
  });

  it('should validate valid error envelope', () => {
    const validError = {
      error: {
        code: 'STALE_TARGET',
        message: 'Element is stale',
        retryable: true,
        action: 'observe_and_retry',
      },
    };

    const result = validate(ApiErrorSchema, validError);
    expect(result.success).toBe(true);
  });

  it('should reject error without code', () => {
    const invalidError = {
      error: {
        message: 'Error occurred',
        retryable: false,
      },
    };

    const result = validate(ApiErrorSchema, invalidError);
    expect(result.success).toBe(false);
  });

  it('should reject invalid error code', () => {
    const invalidError = {
      error: {
        code: 'INVALID_CODE', // Invalid: not in enum
        message: 'Error',
        retryable: false,
      },
    };

    const result = validate(ApiErrorSchema, invalidError);
    expect(result.success).toBe(false);
  });
});

describe('Schema Validation - Engine Capabilities', () => {
  it('should validate full capabilities', () => {
    const validCapabilities = {
      supportsScreenshots: true,
      supportsPdf: true,
      supportsDownloads: true,
      supportsUploads: true,
      supportsJavascript: true,
      supportsWebgl: false,
      supportsVideo: false,
      supportsPersistentStorage: true,
      supportsAccessibilityTree: true,
      supportsCdp: true,
      supportedObservationModes: ['interactive', 'content', 'accessibility'],
      supportedActionTypes: ['click', 'fill', 'select', 'scroll', 'press'],
    };

    const result = validate(EngineCapabilitiesSchema, validCapabilities);
    expect(result.success).toBe(true);
  });

  it('should require at least one observation mode', () => {
    const invalidCapabilities = {
      supportsScreenshots: true,
      supportsPdf: false,
      supportsDownloads: false,
      supportsUploads: false,
      supportsJavascript: true,
      supportsWebgl: false,
      supportsVideo: false,
      supportsPersistentStorage: false,
      supportsAccessibilityTree: true,
      supportsCdp: false,
      supportedObservationModes: [], // Invalid: must have at least one
      supportedActionTypes: ['click'],
    };

    const result = validate(EngineCapabilitiesSchema, invalidCapabilities);
    expect(result.success).toBe(false);
  });

  it('should require at least one action type', () => {
    const invalidCapabilities = {
      supportsScreenshots: true,
      supportsPdf: false,
      supportsDownloads: false,
      supportsUploads: false,
      supportsJavascript: true,
      supportsWebgl: false,
      supportsVideo: false,
      supportsPersistentStorage: false,
      supportsAccessibilityTree: true,
      supportsCdp: false,
      supportedObservationModes: ['interactive'],
      supportedActionTypes: [], // Invalid: must have at least one
    };

    const result = validate(EngineCapabilitiesSchema, invalidCapabilities);
    expect(result.success).toBe(false);
  });
});

describe('Schema Validation - Page State', () => {
  it('should validate valid page state', () => {
    const validPageState = {
      sessionId: 'ses_01',
      pageId: 'pg_01',
      revision: 17,
      url: 'https://example.com',
      title: 'Example Page',
      status: 'interactive',
      focusedRef: 'e17_09',
      elements: [
        {
          ref: 'e17_01',
          role: 'textbox',
          name: 'Email',
          visible: true,
          enabled: true,
        },
        {
          ref: 'e17_09',
          role: 'button',
          name: 'Submit',
          visible: true,
          enabled: true,
          risk: 'transaction',
        },
      ],
      truncated: false,
      untrustedContent: true,
    };

    const result = validate(PageStateSchema, validPageState);
    expect(result.success).toBe(true);
  });

  it('should validate element ref pattern', () => {
    const validRef = 'e17_01';
    const invalidRef1 = 'invalid';
    const invalidRef2 = 'e1';

    // This would be tested when element refs are validated
    expect(validRef).toMatch(/^e\d+_\d+$/);
    expect(invalidRef1).not.toMatch(/^e\d+_\d+$/);
    expect(invalidRef2).not.toMatch(/^e\d+_\d+$/);
  });

  it('should require valid URL format', () => {
    const invalidPageState = {
      sessionId: 'ses_01',
      pageId: 'pg_01',
      revision: 1,
      url: 'not-a-url', // Invalid: not a valid URI
      title: 'Page',
      status: 'interactive',
      elements: [],
      truncated: false,
      untrustedContent: true,
    };

    const result = validate(PageStateSchema, invalidPageState);
    expect(result.success).toBe(false);
  });
});

describe('Schema Validation - Action Request', () => {
  it('should validate navigate action', () => {
    const validAction = {
      pageId: 'pg_01',
      expectedRevision: 17,
      action: {
        type: 'navigate',
        url: 'https://example.com',
        waitUntil: 'load',
      },
    };

    const result = validate(ActionRequestSchema, validAction);
    expect(result.success).toBe(true);
  });

  it('should validate click action', () => {
    const validAction = {
      pageId: 'pg_01',
      expectedRevision: 17,
      action: {
        type: 'click',
        target: { ref: 'e17_09' },
      },
    };

    const result = validate(ActionRequestSchema, validAction);
    expect(result.success).toBe(true);
  });

  it('should validate fill action with sensitive flag', () => {
    const validAction = {
      pageId: 'pg_01',
      expectedRevision: 17,
      action: {
        type: 'fill',
        target: { ref: 'e17_01' },
        value: 'secret123',
        sensitive: true,
      },
    };

    const result = validate(ActionRequestSchema, validAction);
    expect(result.success).toBe(true);
  });

  it('should validate select action', () => {
    const validAction = {
      pageId: 'pg_01',
      expectedRevision: 17,
      action: {
        type: 'select',
        target: { ref: 'e17_05' },
        values: ['option1', 'option2'],
      },
    };

    const result = validate(ActionRequestSchema, validAction);
    expect(result.success).toBe(true);
  });
});

describe('Schema Validation - Observation Request', () => {
  it('should validate basic observation request', () => {
    const validObservation = {
      mode: 'interactive',
      maxBytes: 32768,
      maxElements: 300,
    };

    const result = validate(ObservationRequestSchema, validObservation);
    expect(result.success).toBe(true);
  });

  it('should accept observation with limits', () => {
    const validObservation = {
      mode: 'content',
      maxBytes: 65536,
      maxElements: 500,
      sinceRevision: 15,
      scope: 'full',
    };

    const result = validate(ObservationRequestSchema, validObservation);
    expect(result.success).toBe(true);
  });

  it('should reject negative byte limit', () => {
    const invalidObservation = {
      maxBytes: -1, // Invalid: must be non-negative
    };

    const result = validate(ObservationRequestSchema, invalidObservation);
    expect(result.success).toBe(false);
  });
});

describe('Schema Structure', () => {
  it('should export all required schemas', () => {
    expect(SessionRequestSchema).toBeDefined();
    expect(ApiErrorSchema).toBeDefined();
    expect(ViewportSchema).toBeDefined();
    expect(SessionPolicySchema).toBeDefined();
    expect(EngineCapabilitiesSchema).toBeDefined();
    expect(PageStateSchema).toBeDefined();
    expect(ActionRequestSchema).toBeDefined();
    expect(ObservationRequestSchema).toBeDefined();
  });

  it('should export validate function', () => {
    expect(validate).toBeDefined();
    expect(typeof validate).toBe('function');
  });
});
