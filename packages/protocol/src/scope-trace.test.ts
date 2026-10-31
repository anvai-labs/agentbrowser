import { expect, it } from 'vitest';
import { parseScopeTraceEnd, parseScopeTraceEvent } from './scope-trace.js';

it('refuses unknown fields, control characters and unbounded metadata', () => {
  const event = {
    type: 'scope.denied',
    timestamp: 'now',
    sessionId: 's',
    data: {
      scope: 'SCOPE_METHOD_DENIED',
      method: 'PUT',
      url: 'https://example.test/api',
      hostname: 'example.test',
    },
  };
  expect(parseScopeTraceEvent(event)).toEqual(event);
  for (const bad of [
    { ...event, unknown: true },
    { ...event, sessionId: 's\nforged' },
    { ...event, data: { ...event.data, url: `https://x.test/${'x'.repeat(2048)}` } },
    { ...event, data: { ...event.data, secret: 'x' } },
    { ...event, data: { ...event.data, method: 'PUT\rFORGED' } },
  ])
    expect(() => parseScopeTraceEvent(bad)).toThrow('Invalid scope trace event');
  expect(parseScopeTraceEnd({ reason: 'revoked' })).toEqual({ reason: 'revoked' });
  expect(() => parseScopeTraceEnd({ reason: 'revoked', secret: 'x' })).toThrow();
});
