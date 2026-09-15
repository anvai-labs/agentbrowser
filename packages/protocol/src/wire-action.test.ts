import { describe, expect, it } from 'vitest';
import { validatePlanStep } from './validators.js';
import { decodeWireAction, validateWireAction } from './wire-action.js';

describe('wire action contract', () => {
  it.each([
    { action: 'reload' },
    { action: 'press', key: 'Enter' },
    { action: 'typeText', target: { ref: 'e1_0' }, value: 'Job Board' },
    { action: 'typeText', target: { ref: 'e1_0' }, value: 'Job Board', delay: 50 },
    { action: 'press', key: 'ArrowDown', target: { ref: 'e1_0' }, count: 5 },
    { action: 'press', key: 'ArrowDown', count: 1 },
    { action: 'scroll', direction: 'down', amount: 250 },
    { action: 'wait', condition: { until: 'load' } },
    { action: 'upload', paths: ['/tmp/x.pdf'] },
    { action: 'upload', target: { ref: 'e1_0' }, paths: ['/tmp/a.pdf', '/tmp/b.pdf'] },
  ])('accepts untargeted $action', (action) => {
    expect(validateWireAction(action).ok).toBe(true);
  });
  it.each([
    { action: 'click' },
    { action: 'hover', type: 'click', target: { ref: 'e1_0' } },
    { action: 'select', type: 'click', target: { ref: 'e1_0' }, value: 'one' },
    { action: 'reload', type: 'navigate', url: 'https://example.com' },
    { action: 'press' },
    { action: 'typeText', value: '' },
    { action: 'typeText', value: 'x', delay: 5000 },
    { action: 'typeText', value: 'x'.repeat(5001) },
    { action: 'press', key: 'Enter', count: 0 },
    { action: 'press', key: 'Enter', count: 21 },
    { action: 'press', key: 'Enter', count: 1.5 },
    { action: 'wait' },
    { action: 'reload', target: {} },
    { action: 'click', target: { ref: 'e1_0' }, expectedRevision: -1 },
    { action: 'upload' },
    { action: 'upload', paths: [] },
    { action: 'upload', paths: ['/tmp/x.pdf'], target: { ref: 'nope' } },
  ])('rejects invalid $action', (action) => {
    expect(validateWireAction(action).ok).toBe(false);
  });
  it('accepts type as a deprecated alias for action', () => {
    const result = decodeWireAction({ type: 'click', target: { ref: 'e1_0' } });
    expect(result).toMatchObject({ ok: true, value: { type: 'click', target: { ref: 'e1_0' } } });
    if (result.ok) {
      expect(result.warnings).toEqual(["Field 'type' is deprecated; use 'action'."]);
    }
  });
  it('accepts an untargeted type alias', () => {
    const result = decodeWireAction({ type: 'reload' });
    expect(result).toMatchObject({ ok: true, value: { type: 'reload' } });
    if (result.ok) {
      expect(result.warnings).toEqual(["Field 'type' is deprecated; use 'action'."]);
    }
  });
  it('rejects type when action is also present', () => {
    expect(decodeWireAction({ action: 'click', type: 'click', target: { ref: 'e1_0' } }).ok).toBe(
      false
    );
  });
  it('does not translate an unknown type value', () => {
    expect(decodeWireAction({ type: 'detonate' }).ok).toBe(false);
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
  it('names the flat shape when action is a nested object instead of a string', () => {
    const nested = { action: { type: 'click', target: { ref: 'e1_0' } } };
    for (const result of [decodeWireAction(nested), validatePlanStep(nested)]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toEqual([
          { path: '/action', message: expect.stringMatching(/flat shape/) },
        ]);
        expect(result.issues[0].message).not.toContain('Expected union value');
      }
    }
  });
  it('still reports the required-field error when action is absent', () => {
    const result = validatePlanStep({ target: { ref: 'e1_0' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === '/action')).toBe(true);
      expect(result.issues.every((issue) => !/flat shape/.test(issue.message))).toBe(true);
    }
  });
});
