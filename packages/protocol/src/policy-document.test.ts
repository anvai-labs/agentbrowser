import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  CEDAR_SCHEMA,
  CEDAR_SCHEMA_VERSION,
  CedarPolicySchema,
  PolicyDocumentSchema,
  parsePolicyDocument,
} from './policy-document.js';
import { PolicyDecisionSchema } from './schemas.js';

describe('CEDAR_SCHEMA', () => {
  it('is the versioned contract and names every seam action', () => {
    expect(CEDAR_SCHEMA_VERSION).toBe('agentbrowser-cedar/v1');
    for (const action of [
      'request',
      'request.loopback',
      'request.private',
      'act',
      'act.unattended',
      'cdp.attach',
      'downloads',
      'serviceWorkers',
      'cookie.seed',
      'cookie.export',
      'session.headed',
    ]) {
      expect(CEDAR_SCHEMA).toContain(`"${action}"`);
    }
  });
  it('carries one optional source address on request.private, and the act matchers', () => {
    expect(CEDAR_SCHEMA).toContain('ip?: ipaddr');
    for (const field of ['effect', 'matchedRule', 'hostname', 'role', 'name']) {
      expect(CEDAR_SCHEMA).toContain(`${field}`);
    }
  });
});

const validDocument = {
  version: 'agentbrowser-policy/v1',
  unknownRisk: 'required',
  approvalRules: [{ effect: 'read' }],
  policies: [
    {
      key: 'env.block-loopback#1',
      ruleId: 'env.block-loopback',
      cedar: '@rule("env.block-loopback") forbid(principal, action, resource);',
    },
  ],
};

describe('PolicyDocumentSchema', () => {
  it('accepts a valid document', () => {
    expect(Value.Check(PolicyDocumentSchema, validDocument)).toBe(true);
  });
  it('rejects a wrong version, an unknown effect, extra fields', () => {
    expect(Value.Check(PolicyDocumentSchema, { ...validDocument, version: 'v0' })).toBe(false);
    expect(
      Value.Check(PolicyDocumentSchema, {
        ...validDocument,
        approvalRules: [{ effect: 'nonsense' }],
      })
    ).toBe(false);
    expect(Value.Check(PolicyDocumentSchema, { ...validDocument, extra: true })).toBe(false);
    expect(Value.Check(PolicyDocumentSchema, { ...validDocument, baseline: '' })).toBe(false);
  });
  it('rejects an empty policy body', () => {
    expect(Value.Check(CedarPolicySchema, { key: 'k', ruleId: 'env.x', cedar: '' })).toBe(false);
  });
});

describe('parsePolicyDocument', () => {
  it('round-trips a valid document', () => {
    expect(parsePolicyDocument(validDocument)).toEqual(validDocument);
  });
  it('reports the first structural error', () => {
    expect(() => parsePolicyDocument({ version: 'v0' })).toThrow(
      /Invalid policy document: \/unknownRisk/
    );
  });
  it('rejects duplicate policy keys', () => {
    expect(() =>
      parsePolicyDocument({
        ...validDocument,
        policies: [validDocument.policies[0], validDocument.policies[0]],
      })
    ).toThrow(/duplicate key/);
  });
});

describe('PolicyDecisionSchema rulesMatched', () => {
  it('carries every deciding id alongside the first', () => {
    expect(
      Value.Check(PolicyDecisionSchema, {
        allowed: false,
        reason: 'x',
        ruleMatched: 'env.approval.pay',
        rulesMatched: ['env.approval.pay', 'floor.cdp.attach'],
      })
    ).toBe(true);
    expect(
      Value.Check(PolicyDecisionSchema, {
        allowed: false,
        reason: 'x',
        ruleMatched: 'env.approval.pay',
        rulesMatched: ['env.approval.pay', 7],
      })
    ).toBe(false);
  });
});
