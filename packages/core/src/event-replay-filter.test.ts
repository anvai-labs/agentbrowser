import type { EngineEvent } from '@agentbrowser/engine';
import { describe, expect, it } from 'vitest';
import { compileEventReplayFilter, eventReplayUrl } from './event-replay-filter.js';

const event = (type: EngineEvent['type'], data: Record<string, unknown>): EngineEvent => ({
  type,
  timestamp: '2026-11-02T00:00:00Z',
  sessionId: 'fixture',
  data: { url: 'https://app.test/api/item', method: 'PUT', ...data },
});

describe('published event predicates', () => {
  it('combines URL/method/status/failure selectors without counting policy diagnostics twice', () => {
    const filter = compileEventReplayFilter({ urlRegex: '/api/', method: 'PUT', failedOnly: true });
    expect(filter(event('request.finished', { status: 201 }))).toBe(false);
    expect(filter(event('request.finished', { status: 403 }))).toBe(true);
    expect(filter(event('request.failed', { scope: 'SCOPE_METHOD_DENIED' }))).toBe(true);
    expect(filter(event('scope.denied', { scope: 'SCOPE_METHOD_DENIED' }))).toBe(false);
    expect(filter(event('request.failed', { method: 'GET' }))).toBe(false);
    expect(filter(event('request.failed', { url: 'https://app.test/asset.js' }))).toBe(false);
  });

  it('distinguishes completed HTTP status, policy refusal and unknown passthrough intent', () => {
    const denied = compileEventReplayFilter({ statusClass: 'denied' });
    expect(denied(event('request.finished', { status: 403 }))).toBe(false);
    expect(denied(event('request.failed', { blocked: true, reason: 'egress_policy' }))).toBe(true);
    expect(denied(event('request.failed', { scope: 'SCOPE_HOST_DENIED' }))).toBe(true);
    expect(denied(event('request.failed', { blocked: 'true' }))).toBe(false);
    expect(denied(event('request.failed', { scope: 'SCOPE_MADE_UP' }))).toBe(false);
    for (const data of [
      {},
      { passthrough: true },
      { passthrough: true, status: 200 },
      { status: '200' },
    ])
      expect(
        compileEventReplayFilter({ statusClass: '2xx' })(event('request.finished', data))
      ).toBe(false);
    expect(
      compileEventReplayFilter({ statusClass: '2xx' })(event('request.finished', { status: 204 }))
    ).toBe(true);
    expect(
      compileEventReplayFilter({ statusClass: '5xx' })(event('request.finished', { status: 503 }))
    ).toBe(true);
    expect(compileEventReplayFilter({ failedOnly: false })(event('request.finished', {}))).toBe(
      true
    );
    expect(
      compileEventReplayFilter({ type: 'scope.denied', statusClass: 'denied' })(
        event('scope.denied', { scope: 'SCOPE_METHOD_DENIED' })
      )
    ).toBe(true);
  });

  it('uses only query-stripped HTTP locations and has no stateful regex cursor', () => {
    expect(eventReplayUrl('https://user:pass@app.test/api?PRIVATE_QUERY=1#PRIVATE_FRAGMENT')).toBe(
      'https://app.test/api'
    );
    const hidden = compileEventReplayFilter({ urlRegex: 'PRIVATE_' });
    expect(hidden(event('request.failed', { url: 'https://app.test/path?PRIVATE_QUERY=1' }))).toBe(
      false
    );
    expect(eventReplayUrl('data:text/plain,PRIVATE_QUERY')).toBeUndefined();
    const filter = compileEventReplayFilter({ urlRegex: 'api' });
    expect(filter(event('request.started', {}))).toBe(true);
    expect(filter(event('request.started', {}))).toBe(true);
  });

  it('refuses unsupported and oversized compiled patterns with fixed diagnostics', () => {
    for (const urlRegex of [
      '(?=PRIVATE_PATTERN)',
      '(a)\\1',
      'a{999999999}',
      '(?:ab){1000}',
      '🙂'.repeat(65),
    ]) {
      expect(() => compileEventReplayFilter({ urlRegex })).toThrow('Invalid event URL pattern.');
    }
    const linear = compileEventReplayFilter({ urlRegex: '(a+)+$' });
    expect(linear(event('request.failed', { url: `https://app.test/${'a'.repeat(10000)}!` }))).toBe(
      false
    );
  });
});
