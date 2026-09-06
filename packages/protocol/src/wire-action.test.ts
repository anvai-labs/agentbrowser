import { describe, expect, it } from 'vitest';
import { decodeWireAction, validateWireAction } from './wire-action.js';

describe('wire action contract', () => {
  it.each([
    { action: 'reload' },
    { action: 'press', key: 'Enter' },
    { action: 'scroll', direction: 'down', amount: 250 },
    { action: 'wait', condition: { until: 'load' } },
  ])('accepts untargeted $action', (action) => {
    expect(validateWireAction(action).ok).toBe(true);
  });
  it.each([
    { action: 'click' },
    { action: 'hover', type: 'click', target: { ref: 'e1_0' } },
    { action: 'select', type: 'click', target: { ref: 'e1_0' }, value: 'one' },
    { action: 'reload', type: 'navigate', url: 'https://example.com' },
    { action: 'press' },
    { action: 'wait' },
    { action: 'reload', target: {} },
    { action: 'click', target: { ref: 'e1_0' }, expectedRevision: -1 },
  ])('rejects invalid $action', (action) => {
    expect(validateWireAction(action).ok).toBe(false);
  });
  it('normalizes legacy select without leaking orchestration to the adapter', () => {
    expect(
      decodeWireAction({
        action: 'select',
        target: { ref: 'e1_0' },
        value: 'one',
        approvalToken: 'token',
        observe: 'after',
      })
    ).toEqual({ ok: true, value: { type: 'select', target: { ref: 'e1_0' }, values: ['one'] } });
  });
});
