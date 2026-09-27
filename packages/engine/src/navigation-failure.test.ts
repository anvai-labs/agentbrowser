import { describe, expect, it } from 'vitest';
import { classifyNavigationFailure } from './navigation-failure.js';

describe('bounded navigation failure classification', () => {
  it.each([
    ['ENOTFOUND', 'dns_unresolved'],
    ['ETIMEOUT', 'dns_timeout'],
    ['ETIMEDOUT', 'dns_timeout'],
    ['EREFUSED', 'dns_refused'],
    ['ECONNREFUSED', 'dns_refused'],
    ['EAI_AGAIN', 'engine_error'],
  ])('classifies a resolver-owned %s', (code, reason) => {
    expect(
      classifyNavigationFailure(Object.assign(new Error('private hostname'), { code }), 'dns')
    ).toBe(reason);
  });
  it.each([
    ['page.goto: net::ERR_NAME_NOT_RESOLVED at https://private/', 'dns_unresolved'],
    ['page.goto: net::ERR_DNS_TIMED_OUT at https://private/', 'dns_timeout'],
    ['page.goto: net::ERR_DNS_SERVER_FAILED at https://private/', 'engine_error'],
    ['page.goto: net::ERR_CONNECTION_REFUSED at https://private/', 'connection_refused'],
    ['page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://private/', 'tls_refused'],
    ['page.goto: net::ERR_SSL_PROTOCOL_ERROR at https://private/', 'tls_refused'],
    ['route.fetch: getaddrinfo ENOTFOUND private', 'dns_unresolved'],
    ['route.fetch: connect ECONNREFUSED 10.0.0.1:443', 'connection_refused'],
    ['route.fetch: certificate has expired', 'tls_refused'],
    [
      'page.goto: Timeout 30000ms exceeded.\nCall log:\n - navigating to https://host/net::ERR_NAME_NOT_RESOLVED',
      'engine_error',
    ],
    ['private net::ERR_NAME_NOT_RESOLVED', 'engine_error'],
    ['page.goto: net::ERR_NAME_NOT_RESOLVED_PRIVATE at https://host/', 'engine_error'],
  ])('classifies only transport-owned codes: %s', (message, reason) => {
    expect(classifyNavigationFailure(new Error(message), 'transport')).toBe(reason);
  });
});

it('does not turn URL or call-log prose into a browser crash and preserves safe codes', async () => {
  const { normalizeNavigationFailure } = await import('./navigation-failure.js');
  const result = normalizeNavigationFailure(
    new Error(
      'page.goto: net::ERR_CONNECTION_REFUSED at https://crash.example/private-token\nCall log: browser disconnected'
    )
  );
  expect(result.code).toBe('INTERNAL');
  expect(result.message).toBe('net::ERR_CONNECTION_REFUSED');
  expect(result.details).toEqual({ reason: 'connection_refused' });
});

it.each([
  'page.goto: net::ERR_CONNECTION_CLOSED at https://example/',
  'Navigation to "https://browser.closed.example/" failed',
  'page.goto: net::ERR_FAILED at HTTPS://TARGET.CLOSED.EXAMPLE/',
  'page.goto: Timeout 5ms exceeded.\nCall log:\n browser disconnected at https://connection.closed.example/',
])('does not infer engine death from destination/connection prose: %s', async (message) => {
  const { normalizeNavigationFailure } = await import('./navigation-failure.js');
  const detail = normalizeNavigationFailure(new Error(message));
  expect(detail.code).not.toBe('ENGINE_CRASHED');
  expect(detail.message).not.toMatch(/https|example|Call log/i);
});

it('recognizes genuine driver close and timeout without raw diagnostics', async () => {
  const { normalizeNavigationFailure } = await import('./navigation-failure.js');
  expect(
    normalizeNavigationFailure(
      new Error('page.goto: Target page, context or browser has been closed\nCall log: private')
    )
  ).toMatchObject({ code: 'ENGINE_CRASHED', details: { reason: 'engine_error' } });
  expect(
    normalizeNavigationFailure(new Error('page.goto: Timeout 5ms exceeded.\nCall log: private'))
  ).toMatchObject({ code: 'NAVIGATION_TIMEOUT', details: { reason: 'engine_error' } });
});
