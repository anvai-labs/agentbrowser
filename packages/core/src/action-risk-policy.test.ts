import { describe, expect, it } from 'vitest';
import { ActionRiskPolicy, type ActionRiskPolicyOptions } from './action-risk-policy.js';

describe('operator action risk policy', () => {
  const input = {
    action: 'click',
    url: 'https://shop.example/checkout',
    element: { ref: 'e1_0', role: 'button', name: 'Pay', visible: true, enabled: true },
  };
  it('requires operator-classified transactions without relying on engine risk annotations', () => {
    const policy = new ActionRiskPolicy({
      rules: [{ hostname: 'shop.example', role: 'button', name: 'Pay', effect: 'transaction' }],
    });
    expect(policy.evaluate(input)).toEqual({ effect: 'transaction', decision: 'required' });
    expect(policy.evaluate(input, { transactions: 'allow' }).decision).toBe('required');
    expect(policy.evaluate(input, { transactions: 'deny' }).decision).toBe('deny');
  });
  it('supports explicit strict unknown-risk handling, while reads remain ungated', () => {
    expect(new ActionRiskPolicy().evaluate(input).decision).toBe('allow');
    const strict = new ActionRiskPolicy({ unknownRisk: 'required' });
    expect(strict.evaluate(input).decision).toBe('required');
    expect(strict.evaluate({ ...input, action: 'press' }).decision).toBe('required');
    expect(strict.evaluate({ ...input, action: 'hover' }).decision).toBe('allow');
  });

  it('rejects malformed operator policy options outright', () => {
    expect(() => new ActionRiskPolicy(null as unknown as ActionRiskPolicyOptions)).toThrow(
      'Invalid operator approval policy'
    );
    expect(
      () =>
        new ActionRiskPolicy({
          rules: 'not-an-array' as unknown as ActionRiskPolicyOptions['rules'],
        })
    ).toThrow('Invalid operator approval policy');
    expect(() => new ActionRiskPolicy({ unknownRisk: 'deny' as unknown as 'allow' })).toThrow(
      'Invalid operator approval policy'
    );
  });

  it('rejects malformed operator rules outright', () => {
    expect(
      () =>
        new ActionRiskPolicy({
          rules: [{ effect: 'annihilate' as unknown as 'transaction' }],
        })
    ).toThrow('Invalid operator approval rule');
    expect(
      () =>
        new ActionRiskPolicy({
          rules: [{ effect: 'transaction', decision: 'maybe' as unknown as 'allow' }],
        })
    ).toThrow('Invalid operator approval rule');
    expect(
      () => new ActionRiskPolicy({ rules: [{ effect: 'read', hostname: 42 as unknown as string }] })
    ).toThrow('Invalid operator approval rule');
    expect(
      () => new ActionRiskPolicy({ rules: [{ effect: 'read', name: 'x'.repeat(201) }] })
    ).toThrow('Invalid operator approval rule');
    expect(() => new ActionRiskPolicy({ rules: [null as unknown as never] })).toThrow(
      'Invalid operator approval rule'
    );
  });

  it('caps the rule list at 1000 entries', () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({
      action: `action-${i}`,
      effect: 'read' as const,
    }));
    expect(() => new ActionRiskPolicy({ rules: tooMany })).toThrow(
      'At most 1000 approval rules are supported'
    );
  });

  it('treats a blank URL as a blank host, not a crash', () => {
    // about:blank parses to no host at all: hostname rules against '' still
    // apply, and nothing else may match by hostname.
    const blankPolicy = new ActionRiskPolicy({
      rules: [{ hostname: '', action: 'click', effect: 'transaction' }],
    });
    expect(blankPolicy.evaluate({ action: 'click', url: 'about:blank' })).toEqual({
      effect: 'transaction',
      decision: 'required',
    });
    expect(new ActionRiskPolicy().evaluate({ action: 'click', url: 'not a url at all' })).toEqual({
      effect: 'unknown',
      decision: 'allow',
    });
  });

  it('applies the session external-message restriction over the rule decision', () => {
    const policy = new ActionRiskPolicy({
      rules: [{ action: 'fill', effect: 'external-message', decision: 'allow' }],
    });
    const message = {
      action: 'fill',
      url: 'https://mail.example/compose',
      element: { ...input.element, name: 'Send' },
    };

    // Rule says allow; the stricter session restriction wins on rank.
    expect(policy.evaluate(message, { externalMessages: 'required' }).decision).toBe('required');
    expect(policy.evaluate(message, { externalMessages: 'deny' }).decision).toBe('deny');
    // Without a session restriction the operator's explicit allow stands.
    expect(policy.evaluate(message).decision).toBe('allow');
  });
});
