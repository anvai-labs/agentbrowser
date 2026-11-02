import { describe, expect, it } from 'vitest';
import {
  decodeEventReplayQuery,
  eventReplayStream,
  isFilteredEventReplay,
  validateEventReplayFilterReceipt,
  validateEventReplaySelector,
} from './event-replay.js';

describe('retained event selectors', () => {
  it('requires exact filtered-response acknowledgments without invoking accessors', () => {
    expect(validateEventReplayFilterReceipt({ version: 1, stream: 'request' })).toEqual({
      ok: true,
      value: { version: 1, stream: 'request' },
    });
    for (const value of [
      undefined,
      {},
      { version: 2, stream: 'request' },
      { version: 1, stream: 'other', extra: true },
      Object.create({ version: 1, stream: 'request' }),
    ])
      expect(validateEventReplayFilterReceipt(value).ok).toBe(false);
    let read = false;
    expect(
      validateEventReplayFilterReceipt({
        get version() {
          read = true;
          return 1;
        },
        stream: 'request',
      }).ok
    ).toBe(false);
    expect(read).toBe(false);
  });
  it('preserves documented legacy shapes and does not inject inferred fields', () => {
    for (const selector of [{}, { type: 'console.log' }, { type: 'request.failed', since: -1 }]) {
      expect(validateEventReplaySelector(selector)).toEqual({ ok: true, value: selector });
      expect(isFilteredEventReplay(selector)).toBe(false);
    }
    const result = validateEventReplaySelector({ failedOnly: false, urlRegex: '' });
    expect(result).toEqual({ ok: true, value: { failedOnly: false, urlRegex: '' } });
    if (!result.ok) throw new Error('Expected selector');
    expect(isFilteredEventReplay(result.value)).toBe(true);
    expect(eventReplayStream(result.value)).toBe('request');
    expect(Object.hasOwn(result.value, 'stream')).toBe(false);
  });

  it.each([
    { stream: 'request', since: -1, limit: 1000 },
    { stream: 'other', limit: 1 },
    { type: 'scope.denied', statusClass: 'denied' },
    { method: 'PATCH', statusClass: '4xx', failedOnly: true },
    { method: 'X!TOKEN' },
  ])('selects a compatible ledger for %j', (selector) => {
    expect(validateEventReplaySelector(selector).ok).toBe(true);
  });

  it.each([
    { extra: 'PRIVATE_SELECTOR' },
    { type: '' },
    { type: 'console.log', failedOnly: false },
    { type: 'request.failed', stream: 'other' },
    { type: 'console.log', stream: 'request' },
    { stream: 'other', method: 'GET' },
    { since: 0 },
    { limit: 1 },
    { stream: 'request', since: -2 },
    { stream: 'request', since: Number.MAX_SAFE_INTEGER + 1 },
    { stream: 'request', limit: 1001 },
    { failedOnly: 'false' },
    { statusClass: '3xx' },
    { method: 'get' },
    { method: 'G ET' },
    { method: 'Ä' },
    { method: 'X'.repeat(33) },
    { urlRegex: '🙂'.repeat(65) },
  ])('refuses malformed or ambiguous selectors without value echo: %j', (selector) => {
    const result = validateEventReplaySelector(selector);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SELECTOR');
  });

  it('enforces UTF-8 bounds and detaches the validated fields', () => {
    const source = { urlRegex: '🙂'.repeat(64), failedOnly: true };
    const result = validateEventReplaySelector(source);
    expect(result.ok).toBe(true);
    source.urlRegex = 'changed';
    if (!result.ok) throw new Error('Expected selector');
    expect(result.value.urlRegex).toBe('🙂'.repeat(64));
    expect(Object.isFrozen(result.value)).toBe(true);
    let read = false;
    expect(
      validateEventReplaySelector({
        get method() {
          read = true;
          return 'GET';
        },
      }).ok
    ).toBe(false);
    expect(read).toBe(false);
  });

  it('decodes exact HTTP spellings and rejects duplicate/noncanonical query values', () => {
    expect(
      decodeEventReplayQuery({ stream: 'request', since: '-1', limit: '2', failedOnly: 'false' })
    ).toEqual({ ok: true, value: { stream: 'request', since: -1, limit: 2, failedOnly: false } });
    for (const query of [
      { stream: 'request', since: '' },
      { stream: 'request', since: ' 1' },
      { stream: 'request', since: '1e2' },
      { stream: 'request', limit: '01' },
      { stream: 'request', limit: '-1' },
      { failedOnly: 'TRUE' },
      { method: ['GET', 'POST'] },
      { urlRegex: ['api', 'secret'] },
      { unknown: 'PRIVATE_QUERY' },
    ]) {
      const result = decodeEventReplayQuery(query);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_QUERY');
    }
  });
});
