import { expect, it } from 'vitest';
import { DenialTrace, denialTraceLine } from './denial-trace.js';

it('sanitizes live denial metadata without granting permission or exposing URL credentials/query', () => {
  const trace = new DenialTrace(['vinted.com']);
  const event = trace.note(
    {
      method: 'PUT',
      url: 'https://user:password@vinted.com/api/verify?code=secret#fragment',
      scope: 'SCOPE_METHOD_DENIED',
    },
    0
  );
  expect(event).toEqual({
    method: 'PUT',
    url: 'https://vinted.com/api/verify',
    hostname: 'vinted.com',
    scope: 'SCOPE_METHOD_DENIED',
  });
  expect(denialTraceLine({ ...event!, timestamp: '2026-10-30T00:00:00Z' })).toContain(
    'SCOPE_METHOD_DENIED PUT https://vinted.com/api/verify'
  );
  expect(trace.note({ scope: 'SCOPE_UNKNOWN', url: 'https://vinted.com' }, 0)).toBeUndefined();
});
it('hints only after three recent host denials for vendors or a shared registry label', () => {
  const trace = new DenialTrace(['vinted.com']);
  for (const host of ['dd.vinted.lt', 'cdn.cookielaw.org', 'evil-vinted.example.org']) {
    for (let i = 0; i < 3; i++)
      trace.note({ method: 'GET', url: `https://${host}/tag`, scope: 'SCOPE_HOST_DENIED' }, i);
  }
  const hints = trace.hints(10);
  expect(hints.map((h) => h.hostname).sort()).toEqual(['cdn.cookielaw.org', 'dd.vinted.lt']);
  expect(hints.every((h) => h.message.includes('may be starved'))).toBe(true);
  expect(trace.hints(6000)).toEqual([]);
  const method = new DenialTrace(['vinted.com']);
  for (let i = 0; i < 3; i++)
    method.note({ method: 'PUT', url: 'https://dd.vinted.lt/', scope: 'SCOPE_METHOD_DENIED' }, i);
  expect(method.hints(10)).toEqual([]);
});

it('requires three denials in the window rather than three spread over successive windows', () => {
  const trace = new DenialTrace(['vinted.com']);
  for (const at of [0, 4000, 8000])
    trace.note({ method: 'GET', url: 'https://dd.vinted.lt/', scope: 'SCOPE_HOST_DENIED' }, at);
  expect(trace.hints(8001)).toEqual([]);
});
