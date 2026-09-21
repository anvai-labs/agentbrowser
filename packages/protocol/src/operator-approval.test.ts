import { expect, it } from 'vitest';
import {
  parseOperatorApprovalView,
  validateOperatorApprovalDecision,
} from './operator-approval.js';
import { validateSessionRequest } from './validators.js';
const view = {
  tokenId: 'tok_1',
  status: 'pending',
  createdAt: 1,
  expiresAt: 2,
  action: { type: 'click', parameters: { target: { ref: 'e1_0' } } },
};
it('accepts operator review policy without changing legacy session policy', () => {
  expect(validateSessionRequest({ policy: { approval: { review: 'operator' } } }).ok).toBe(true);
  expect(validateSessionRequest({ policy: { approval: { review: 'agent' } } }).ok).toBe(false);
  expect(validateSessionRequest({}).ok).toBe(true);
});
it('strictly validates the decision body', () => {
  expect(validateOperatorApprovalDecision({ decision: 'approve' }).ok).toBe(true);
  expect(validateOperatorApprovalDecision({ decision: 'deny' }).ok).toBe(true);
  for (const invalid of [{ decision: 'yes' }, { decision: 'approve', extra: 1 }, [], null])
    expect(validateOperatorApprovalDecision(invalid).ok).toBe(false);
});
it('returns a detached bounded operator view', () => {
  const parsed = parseOperatorApprovalView(view);
  expect(parsed).toEqual(view);
  expect(parsed.action).not.toBe(view.action);
});
it.each([
  { ...view, status: 'unknown' },
  { ...view, extra: true },
  { ...view, action: { value: 'PRIVATE'.repeat(20000) } },
])('refuses malformed views without private diagnostics', (input) => {
  expect(() => parseOperatorApprovalView(input)).toThrow('Invalid operator approval view');
});
it('does not invoke getters in private review data', () => {
  let accessed = false;
  const action = Object.defineProperty({}, 'private', {
    enumerable: true,
    get() {
      accessed = true;
      return 'PRIVATE';
    },
  });
  expect(() => parseOperatorApprovalView({ ...view, action })).toThrow(
    'Invalid operator approval view'
  );
  expect(accessed).toBe(false);
});
