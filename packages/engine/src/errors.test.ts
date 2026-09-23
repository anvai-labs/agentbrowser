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

describe('adapter error normalization: prose classification', () => {
  it('classifies a non-object thrown value as INTERNAL and withholds its text', () => {
    // INTERNAL is a server fault: the raw message (driver paths, topology,
    // stack-adjacent detail) is classification input only and must not reach
    // clients, where redact() cannot scrub unregistered values.
    expect(normalizeEngineError('Session socket hung up')).toMatchObject({
      code: 'INTERNAL',
      message: 'An unexpected engine error occurred',
      retryable: false,
    });
    expect(normalizeEngineError(undefined).code).toBe('INTERNAL');
    expect(
      normalizeEngineError(new Error('topology /internal/preview-7 unreachable'))
    ).toMatchObject({
      code: 'INTERNAL',
      message: 'An unexpected engine error occurred',
    });
    // Navigation exposes only the transport code, never URLs or surrounding prose.
    expect(
      normalizeEngineError(
        new Error('net::ERR_CONNECTION_REFUSED at http://dead.example/'),
        'navigate'
      )
    ).toMatchObject({
      code: 'INTERNAL',
      message: 'net::ERR_CONNECTION_REFUSED',
    });
  });

  it.each([
    ['PRIVATE_TOPOLOGY_DIAGNOSTIC', 'An unexpected engine error occurred'],
    [
      'page.goto: net::ERR_NAME_NOT_RESOLVED at https://user:PRIVATE_PASSWORD@host/?token=PRIVATE_QUERY',
      'net::ERR_NAME_NOT_RESOLVED',
    ],
    ['net::ERR_bad_PRIVATE_PROSE', 'An unexpected engine error occurred'],
    ['net::ERR_PRIVATE_CREDENTIAL', 'An unexpected engine error occurred'],
    ['net::ERR_CONNECTION_REFUSED_PRIVATE_SUFFIX', 'An unexpected engine error occurred'],
    ['privatenet::ERR_CONNECTION_REFUSED', 'An unexpected engine error occurred'],
    [`net::ERR_${'A'.repeat(81)}`, 'An unexpected engine error occurred'],
  ])('bounds navigation INTERNAL diagnostics: %s', (message, expected) => {
    expect(normalizeEngineError(new Error(message), 'navigate')).toEqual({
      code: 'INTERNAL',
      message: expected,
      retryable: false,
    });
  });

  it.each(['RESPONSE_TOO_LARGE', 'MAX_REDIRECTS', 'REDIRECT_LOOP'])(
    'maps the legacy code %s onto POLICY_DENIED',
    (legacyCode) => {
      const error = Object.assign(new Error('redirect budget exhausted'), {
        code: legacyCode,
      });
      expect(normalizeEngineError(error)).toMatchObject({
        code: 'POLICY_DENIED',
        message: 'redirect budget exhausted',
      });
    }
  );

  it('classifies transport-death prose as ENGINE_CRASHED', () => {
    for (const message of [
      'Target page closed',
      'Browser has been closed',
      'Browser disconnected unexpectedly',
      'Context closed',
    ]) {
      expect(normalizeEngineError(new Error(message), 'act').code).toBe('ENGINE_CRASHED');
    }
  });

  it('classifies quota prose as QUOTA_EXCEEDED', () => {
    expect(normalizeEngineError(new Error('QUOTA_EXCEEDED: too many sessions')).code).toBe(
      'QUOTA_EXCEEDED'
    );
  });

  it('classifies the bare session-not-found sentinel and rewords it for callers', () => {
    const normalized = normalizeEngineError(new Error('SESSION_NOT_FOUND'), 'act');
    expect(normalized).toMatchObject({
      code: 'SESSION_NOT_FOUND',
      message: 'Session does not exist.',
    });
  });

  it('classifies staleness prose as STALE_TARGET', () => {
    for (const message of ['element is stale after navigation', 'fingerprint mismatch']) {
      expect(normalizeEngineError(new Error(message), 'act').code).toBe('STALE_TARGET');
    }
  });

  it('classifies ambiguous-target prose as TARGET_AMBIGUOUS', () => {
    for (const message of ['multiple elements match the ref', 'resolver is ambiguous']) {
      expect(normalizeEngineError(new Error(message), 'act').code).toBe('TARGET_AMBIGUOUS');
    }
  });

  it('classifies missing-element prose as TARGET_NOT_FOUND', () => {
    expect(normalizeEngineError(new Error('Element not found'), 'act').code).toBe(
      'TARGET_NOT_FOUND'
    );
  });

  it('classifies dialog prose as INVALID_REQUEST', () => {
    expect(normalizeEngineError(new Error('No dialog is currently open'), 'act')).toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('falls back to INTERNAL when nothing matches, even for an unknown string code', () => {
    const error = Object.assign(new Error('nothing recognizable'), {
      code: 'SOMETHING_CUSTOM',
    });
    expect(normalizeEngineError(error)).toMatchObject({
      code: 'INTERNAL',
      message: 'An unexpected engine error occurred',
    });
  });

  it('honors a boolean retryable flag and drops malformed or absent details', () => {
    const coded = (extras: Record<string, unknown>): Error => Object.assign(new Error('x'), extras);

    expect(
      normalizeEngineError(coded({ code: 'STALE_TARGET', retryable: true, details: { a: 1 } }))
    ).toEqual({ code: 'STALE_TARGET', message: 'x', retryable: true, details: { a: 1 } });
    expect(normalizeEngineError(coded({ code: 'STALE_TARGET', retryable: 'yes' }))).toEqual({
      code: 'STALE_TARGET',
      message: 'x',
      retryable: false,
    });
    expect(
      normalizeEngineError(coded({ code: 'STALE_TARGET', details: null })).details
    ).toBeUndefined();
    expect(
      normalizeEngineError(coded({ code: 'STALE_TARGET', details: ['array'] })).details
    ).toBeUndefined();
    expect(
      normalizeEngineError(coded({ code: 'STALE_TARGET', details: 'nope' })).details
    ).toBeUndefined();
  });
});

describe('engine package barrel', () => {
  it('re-exports the error surface from the package index', async () => {
    const barrel = await import('./index.js');
    expect(barrel.EngineError).toBe(EngineError);
    expect(barrel.normalizeEngineError).toBe(normalizeEngineError);
  });
});
