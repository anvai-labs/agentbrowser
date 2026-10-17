import { expect, it } from 'vitest';
import { downloadFailureDetail } from './download-failure.js';
import { ErrorCode } from './errors.js';
import { SCOPE_DENIAL_CODES } from './navigation-failure.js';

it.each(SCOPE_DENIAL_CODES)('projects download refusal %s without private details', (scope) => {
  const result = downloadFailureDetail({
    code: 'POLICY_DENIED',
    message: 'private adapter prose',
    retryable: true,
    details: {
      scope,
      stage: 'redirect',
      reason: 'transferFailed',
      operationId: 'download-once',
      url: 'https://private.invalid/?token=fixture-only',
      headers: { authorization: 'fixture-only' },
    },
  });
  expect(result).toEqual({
    code: ErrorCode.POLICY_DENIED,
    message: `Download failed (${scope})`,
    retryable: false,
    details: { scope, stage: 'redirect', reason: 'transferFailed', operationId: 'download-once' },
  });
  expect(JSON.stringify(result)).not.toMatch(/private|fixture-only|authorization/);
});

it.each(['admission', 'connect', 'tls', 'headers', 'response', 'redirect', 'body'])(
  'retains the known download stage %s',
  (stage) => {
    expect(downloadFailureDetail({ code: 'ACTION_TIMEOUT', details: { stage } })).toEqual({
      code: ErrorCode.ACTION_TIMEOUT,
      message: 'Download failed',
      retryable: false,
      details: { stage },
    });
  }
);

it.each([
  undefined,
  null,
  'private prose',
  {
    code: 'PRIVATE-CODE',
    message: 'private prose',
    details: {
      stage: 'private-stage',
      reason: 'private-reason',
      scope: 'private-scope',
      operationId: 'private id',
    },
  },
])('uses a fixed bounded fallback for unrecognized failure data', (failure) => {
  expect(downloadFailureDetail(failure)).toEqual({
    code: ErrorCode.INTERNAL,
    message: 'Download failed',
    retryable: false,
  });
});

it('reads allowlisted values once before projection', () => {
  const once = (value: string) => {
    let reads = 0;
    return () => (++reads === 1 ? value : 'private-second-read');
  };
  const result = downloadFailureDetail({
    get code() {
      return readCode();
    },
    details: Object.defineProperties(
      {},
      {
        scope: { get: once('SCOPE_PATH_DENIED') },
        stage: { get: once('connect') },
        reason: { get: once('transferFailed') },
        operationId: { get: once('download-once') },
      }
    ),
  });
  function readCode() {
    return 'POLICY_DENIED';
  }
  expect(result.details).toEqual({
    scope: 'SCOPE_PATH_DENIED',
    stage: 'connect',
    reason: 'transferFailed',
    operationId: 'download-once',
  });
  expect(JSON.stringify(result)).not.toContain('private');
});
