import { describe, expect, it } from 'vitest';
import { ActionRiskPolicy } from './action-risk-policy.js';

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
});
