import { Value } from '@sinclair/typebox/value';
import { expect, it } from 'vitest';
import { NavigationFailureReasonSchema, navigationFailureDetail } from './navigation-failure.js';

it('bounds navigation reasons and projects no raw topology or details', () => {
  for (const reason of [
    'dns_nxdomain',
    'dns_unresolved',
    'connection_refused',
    'dns_timeout',
    'dns_refused',
    'tls_refused',
    'egress_policy',
    'browser_error_document',
    'engine_error',
  ]) {
    expect(Value.Check(NavigationFailureReasonSchema, reason)).toBe(true);
    const error = Object.assign(new Error('private-address secret-token'), {
      code: 'INTERNAL',
      retryable: false,
      details: { reason, address: '10.0.0.1', url: 'https://private/' },
    });
    expect(navigationFailureDetail(error)).toEqual({
      code: 'INTERNAL',
      message: `Navigation failed: ${reason}`,
      retryable: false,
      details: { reason },
    });
  }
  for (const reason of ['bot_wall', '10.0.0.1', null, 1, {}]) {
    expect(Value.Check(NavigationFailureReasonSchema, reason)).toBe(false);
    expect(navigationFailureDetail({ details: { reason } })).toBeUndefined();
  }
});

it('retains only a canonical operation identity for reconciliation', () => {
  expect(
    navigationFailureDetail({
      code: 'INTERNAL',
      details: {
        reason: 'engine_error',
        operationId: 'navigate_once-1',
        address: '10.0.0.1',
      },
    })
  ).toMatchObject({ details: { reason: 'engine_error', operationId: 'navigate_once-1' } });

  for (const operationId of ['', 'bad operation id', 'x'.repeat(129), 1, null, {}]) {
    expect(
      navigationFailureDetail({
        code: 'INTERNAL',
        details: { reason: 'engine_error', operationId, address: '10.0.0.1' },
      })?.details
    ).toEqual({ reason: 'engine_error' });
  }
});
