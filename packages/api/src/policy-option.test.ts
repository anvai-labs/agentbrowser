/** The entrypoint's policy option carries a file's approval rules (and only a file's). */
import { describe, expect, it } from 'vitest';
import { serverPolicyOption } from './policy-option.js';

const authorizer = { version: 'sha256:x', decide: () => ({ allowed: true }) } as never;

describe('serverPolicyOption', () => {
  it('hands a policy file approval rules and unknownRisk to the server', () => {
    const option = serverPolicyOption({
      kind: 'file',
      authorizer,
      limits: {},
      document: {
        version: 'agentbrowser-policy/v1',
        baseline: 'none',
        unknownRisk: 'allow',
        approvalRules: [{ id: 'r1', name: 'Place order', effect: 'transaction' }],
        policies: [],
      } as never,
    });
    expect(option).toMatchObject({
      kind: 'file',
      version: 'sha256:x',
      approval: {
        rules: [{ id: 'r1', name: 'Place order', effect: 'transaction' }],
        unknownRisk: 'allow',
      },
    });
  });

  it('gives shadow mode no approval: the environment approval policy still applies there', () => {
    const option = serverPolicyOption({ kind: 'shadow', authorizer, version: 'v', limits: {} });
    expect(option).not.toHaveProperty('approval');
    expect(option.kind).toBe('shadow');
  });
});
