import type { ActionRiskRule } from '@agentbrowser/core';
import { describe, expect, it } from 'vitest';
import {
  type CedarGenerationConfig,
  cedarPolicySetFromLegacyConfig,
  expandRangesForCedar,
  normalizeSourceForCedar,
  parseCidr,
  policyDocumentFromEnvironment,
  policyDocumentFromLegacyConfig,
} from './cedar-generator.js';

describe('parseCidr', () => {
  it('accepts what compilePrivateCIDRs accepts', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ subnet: '10.0.0.0', prefix: 8, family: 4 });
    expect(parseCidr('::ffff:10.0.0.0/104')).toEqual({
      subnet: '::ffff:10.0.0.0',
      prefix: 104,
      family: 6,
    });
    expect(parseCidr('::/0').prefix).toBe(0);
  });
  it('rejects the same input with the same message', () => {
    for (const bad of ['10.0.0.0', '10.0.0.0/33', '::/129', 'not-an-ip/8', '10.0.0.0/8/9', '']) {
      expect(() => parseCidr(bad)).toThrow(
        'Invalid allowedPrivateCIDRs CIDR: expected an IP address and valid prefix'
      );
    }
  });
});

describe('expandRangesForCedar', () => {
  // Every expectation is the empirically verified BlockList matrix: an IPv4
  // address is checked as ::ffff:a.b.c.d against IPv6 rules, so mapped-space
  // rules stand for their IPv4 range and prefix-constant rules for all of it.
  const cases: Array<[string[], string[]]> = [
    [['10.0.0.0/8'], ['10.0.0.0/8']],
    [['192.168.1.0/24'], ['192.168.1.0/24']],
    [['::/0'], ['::/0', '0.0.0.0/0']],
    [['::/80'], ['::/80', '0.0.0.0/0']],
    [['::/95'], ['::/95']],
    [['::/96'], ['::/96']],
    [['::ffff:0:0/96'], ['0.0.0.0/0']],
    [['::ffff:10.0.0.0/104'], ['10.0.0.0/8']],
    [['::ffff:192.168.1.0/120'], ['192.168.1.0/24']],
    [['::ffff:0:1:0/95'], ['::ffff:0:1:0/95']], // four groups after ::, not mapped space
    [['::ffff:0:0/95'], ['::ffff:0:0/95', '0.0.0.0/0']], // prefix under 96 grants all IPv4
    [['64:ff9b::/96'], ['64:ff9b::/96']],
    [['2001:db8::/32'], ['2001:db8::/32']],
    [['10.0.0.0/8', '10.0.0.0/8'], ['10.0.0.0/8']],
    [
      ['::ffff:0:0/96', '::/0'],
      ['0.0.0.0/0', '::/0'],
    ],
  ];
  for (const [input, expected] of cases) {
    it(`${input.join(', ') || '(empty)'} -> ${expected.join(', ') || '(none)'}`, () => {
      expect(expandRangesForCedar(input)).toEqual(expected);
    });
  }
});

describe('normalizeSourceForCedar', () => {
  it('sends mapped-space IPv6 as its IPv4 address', () => {
    expect(normalizeSourceForCedar('::ffff:10.1.2.3', 'ipv6')).toBe('10.1.2.3');
    expect(normalizeSourceForCedar('::ffff:a01:203', 'ipv6')).toBe('10.1.2.3');
  });
  it('sends everything else as written', () => {
    expect(normalizeSourceForCedar('10.1.2.3', 'ipv4')).toBe('10.1.2.3');
    expect(normalizeSourceForCedar('64:ff9b::a01:203', 'ipv6')).toBe('64:ff9b::a01:203');
    expect(normalizeSourceForCedar('::1', 'ipv6')).toBe('::1');
  });
  it('throws on non-addresses and family mismatches', () => {
    expect(() => normalizeSourceForCedar('example.com', 'ipv4')).toThrow(
      /not a valid ipv4 address/
    );
    expect(() => normalizeSourceForCedar('fd12::1', 'ipv4')).toThrow(/not a valid ipv4 address/);
    expect(() => normalizeSourceForCedar('10.1.2.3', 'ipv6')).toThrow(/not a valid ipv6 address/);
  });
});

const text = (config: CedarGenerationConfig, ruleId: string) =>
  cedarPolicySetFromLegacyConfig(config)
    .filter((policy) => policy.ruleId === ruleId)
    .map((policy) => policy.cedar);

describe('cedarPolicySetFromLegacyConfig', () => {
  it('emits unique keys and @rule annotations for every policy', () => {
    const policies = cedarPolicySetFromLegacyConfig({
      allowLoopback: true,
      allowedPrivateCIDRs: ['10.0.0.0/8'],
      rules: [{ id: 'pay', effect: 'transaction', decision: 'deny' }, { effect: 'read' }],
    });
    expect(new Set(policies.map((p) => p.key)).size).toBe(policies.length);
    for (const policy of policies) {
      expect(policy.cedar.startsWith(`@rule("${policy.ruleId}") `)).toBe(true);
      expect(policy.ruleId.startsWith('env.')).toBe(true);
    }
  });

  it('loopback: permit when allowed, forbid when not', () => {
    expect(text({ allowLoopback: true }, 'env.allow-loopback')).toEqual([
      '@rule("env.allow-loopback") permit(principal, action == AgentBrowser::Action::"request.loopback", resource);',
    ]);
    expect(text({}, 'env.block-loopback')).toEqual([
      '@rule("env.block-loopback") forbid(principal, action == AgentBrowser::Action::"request.loopback", resource);',
    ]);
  });

  it('private: cover expression over expanded ranges, in order', () => {
    const [permit] = text(
      { allowedPrivateCIDRs: ['10.0.0.0/8', '::ffff:192.168.1.0/120'] },
      'env.allowed-cidrs'
    );
    expect(permit).toBe(
      '@rule("env.allowed-cidrs") permit(principal, action == AgentBrowser::Action::"request.private", resource) ' +
        'when { context has ip && (context.ip.isInRange(ip("10.0.0.0/8")) || context.ip.isInRange(ip("192.168.1.0/24"))) };'
    );
    const [forbid] = text({ allowedPrivateCIDRs: ['10.0.0.0/8'] }, 'env.block-private');
    expect(forbid).toContain(
      'unless { context has ip && (context.ip.isInRange(ip("10.0.0.0/8"))) }'
    );
  });

  it('private: no CIDRs means an unconditional forbid and no permit', () => {
    const policies = cedarPolicySetFromLegacyConfig({});
    expect(text({}, 'env.allowed-cidrs')).toEqual([]);
    expect(text({}, 'env.block-private')).toEqual([
      '@rule("env.block-private") forbid(principal, action == AgentBrowser::Action::"request.private", resource);',
    ]);
    expect(policies.filter((p) => p.cedar.includes('isInRange'))).toEqual([]);
  });

  it('approval: one branch per decided rule, keyed on its id', () => {
    const rules: ActionRiskRule[] = [
      { id: 'pay', effect: 'transaction', decision: 'deny' },
      { id: 'send-mail', effect: 'external-message', decision: 'allow' },
      { effect: 'read', decision: 'required' },
    ];
    const policies = cedarPolicySetFromLegacyConfig({ rules });
    expect(
      policies.filter((p) => p.cedar.includes('matchedRule == "pay"')).map((p) => p.ruleId)
    ).toEqual(['env.approval.pay']);
    expect(policies.find((p) => p.cedar.includes('matchedRule == "pay"'))?.cedar).toContain(
      'forbid'
    );
    expect(policies.find((p) => p.cedar.includes('matchedRule == "send-mail"'))?.cedar).toContain(
      'permit'
    );
    // The unnamed decided rule is keyed on its array index.
    expect(policies.some((p) => p.cedar.includes('matchedRule == "rule-2"'))).toBe(true);
    // Undecided rules get no branch of their own.
    expect(policies.some((p) => p.cedar.includes('matchedRule == "rule-1"'))).toBe(false);
  });

  it('approval: three modes shape the act and unattended policies', () => {
    const deny = text({ rules: [{ id: 'a', effect: 'read', decision: 'deny' }] }, 'env.approval.a');
    expect(deny).toHaveLength(1);
    expect(deny[0]).toContain(
      'forbid(principal, action in [AgentBrowser::Action::"act", AgentBrowser::Action::"act.unattended"]'
    );

    const allow = text(
      { rules: [{ id: 'a', effect: 'read', decision: 'allow' }] },
      'env.approval.a'
    );
    expect(allow).toHaveLength(2);
    expect(allow.every((p) => p.startsWith('@rule("env.approval.a") permit'))).toBe(true);

    const required = text(
      { rules: [{ id: 'a', effect: 'read', decision: 'required' }] },
      'env.approval.a'
    );
    expect(required).toHaveLength(2);
    expect(required[0]).toContain('permit(principal, action == AgentBrowser::Action::"act"');
    expect(required[1]).toContain(
      'forbid(principal, action == AgentBrowser::Action::"act.unattended"'
    );
  });

  it('defaults apply only when the matched rule has no decision', () => {
    const rules: ActionRiskRule[] = [
      { id: 'pay', effect: 'transaction', decision: 'deny' },
      { effect: 'read' },
    ];
    const policies = cedarPolicySetFromLegacyConfig({ rules });
    const exclusion = '!(["pay"].contains(context.matchedRule)) && ';
    for (const ruleId of [
      'env.approval.unknown-risk',
      'env.approval.high-risk',
      'env.approval.default',
    ]) {
      for (const policy of policies.filter((p) => p.ruleId === ruleId)) {
        expect(policy.cedar).toContain(exclusion);
      }
    }
  });

  it('high-risk and default branches split by effect', () => {
    const highRisk = text({}, 'env.approval.high-risk');
    expect(
      highRisk.some((cedar) =>
        cedar.includes(
          '["transaction", "account-security", "external-message", "destructive"].contains(context.effect)'
        )
      )
    ).toBe(true);
    const rest = text({}, 'env.approval.default');
    expect(
      rest.some((cedar) =>
        cedar.includes(
          '!(["transaction", "account-security", "external-message", "destructive", "unknown"].contains(context.effect))'
        )
      )
    ).toBe(true);
  });

  it('unknownRisk=required splits the unknown branch', () => {
    const required = text({ unknownRisk: 'required' }, 'env.approval.unknown-risk');
    expect(required).toHaveLength(2);
    expect(required[1]).toContain(
      'forbid(principal, action == AgentBrowser::Action::"act.unattended"'
    );
  });

  it('capabilities: one policy granting all six', () => {
    const [policy] = text({}, 'env.capability.default');
    expect(policy).toBe(
      '@rule("env.capability.default") permit(principal, action in [' +
        [
          'cdp.attach',
          'downloads',
          'serviceWorkers',
          'cookie.seed',
          'cookie.export',
          'session.headed',
        ]
          .map((a) => `AgentBrowser::Action::"${a}"`)
          .join(', ') +
        '], resource);'
    );
  });
});

describe('cedarPolicySetFromLegacyConfig validates its input', () => {
  it('rejects rule ids ActionRiskPolicy would refuse', () => {
    for (const id of ['\x00null', 'a\x1b[31mb', 'a\uD800', 'Bad-ID', 'rule-2', 'none', '-x']) {
      expect(() =>
        cedarPolicySetFromLegacyConfig({ rules: [{ id, effect: 'read', decision: 'allow' }] })
      ).toThrow(/Invalid operator approval rule/);
    }
  });
  it('rejects duplicate ids, bad decisions and over-long matchers', () => {
    expect(() =>
      cedarPolicySetFromLegacyConfig({
        rules: [
          { id: 'dup', effect: 'read', decision: 'allow' },
          { id: 'dup', effect: 'read', decision: 'deny' },
        ],
      })
    ).toThrow(/duplicates an earlier rule id/);
    expect(() =>
      cedarPolicySetFromLegacyConfig({ rules: [{ effect: 'read', decision: 'maybe' }] })
    ).toThrow(/Invalid operator approval rule/);
    expect(() =>
      cedarPolicySetFromLegacyConfig({
        rules: [{ effect: 'read', name: 'x'.repeat(201) }],
      })
    ).toThrow(/Invalid operator approval rule/);
  });
  it('rejects unknownRisk values ActionRiskPolicy would refuse', () => {
    for (const bad of ['garbage', 'ALLOW', '']) {
      expect(() => cedarPolicySetFromLegacyConfig({ unknownRisk: bad as 'allow' })).toThrow(
        /Invalid operator approval policy/
      );
      expect(() => policyDocumentFromLegacyConfig({ unknownRisk: bad as 'allow' })).toThrow(
        /Invalid operator approval policy/
      );
    }
  });
  it('accepts every id shape the system allows', () => {
    expect(() =>
      cedarPolicySetFromLegacyConfig({
        rules: [{ id: 'a1.b_c-d', effect: 'read', decision: 'required' }],
      })
    ).not.toThrow();
  });
});

describe('policyDocumentFromLegacyConfig', () => {
  it('carries the configuration and the set', () => {
    const document = policyDocumentFromLegacyConfig({
      unknownRisk: 'required',
      allowLoopback: true,
      allowedPrivateCIDRs: ['10.0.0.0/8'],
      rules: [{ id: 'pay', effect: 'transaction', decision: 'deny' }],
    });
    expect(document.version).toBe('agentbrowser-policy/v1');
    expect(document.baseline).toBe('agentbrowser:baseline/v1');
    expect(document.unknownRisk).toBe('required');
    expect(document.approvalRules).toEqual([
      { id: 'pay', effect: 'transaction', decision: 'deny' },
    ]);
    expect(document.policies).toEqual(
      cedarPolicySetFromLegacyConfig({
        unknownRisk: 'required',
        allowLoopback: true,
        allowedPrivateCIDRs: ['10.0.0.0/8'],
        rules: [{ id: 'pay', effect: 'transaction', decision: 'deny' }],
      })
    );
  });
  it('omits undefined rule fields rather than writing them', () => {
    const document = policyDocumentFromLegacyConfig({ rules: [{ effect: 'read' }] });
    expect(document.approvalRules).toEqual([{ effect: 'read' }]);
    expect('id' in document.approvalRules[0]).toBe(false);
  });
});

describe('policyDocumentFromEnvironment', () => {
  const env = (over: Record<string, string>) =>
    over as Parameters<typeof policyDocumentFromEnvironment>[0];
  it('parses exactly as the service does', () => {
    const document = policyDocumentFromEnvironment(
      env({
        AGENTBROWSER_ALLOWED_CIDRS: ' 10.0.0.0/8 , ::ffff:192.168.1.0/120 ',
        AGENTBROWSER_ALLOW_LOOPBACK: 'TRUE',
        AGENTBROWSER_APPROVAL_POLICY:
          '{"unknownRisk":"required","rules":[{"id":"pay","effect":"transaction","decision":"deny"}]}',
      })
    );
    expect(document.unknownRisk).toBe('required');
    expect(document.approvalRules).toEqual([
      { id: 'pay', effect: 'transaction', decision: 'deny' },
    ]);
    // The mapped-space CIDR stands for its IPv4 range in the cover.
    const cover = document.policies.find((p) => p.ruleId === 'env.allowed-cidrs')?.cedar ?? '';
    expect(cover).toContain('ip("10.0.0.0/8")');
    expect(cover).toContain('ip("192.168.1.0/24")');
    expect(document.policies.some((p) => p.ruleId === 'env.allow-loopback')).toBe(true);
  });
  it('treats unset, empty and non-affirmative values as off', () => {
    for (const e of [
      env({}),
      env({ AGENTBROWSER_ALLOWED_CIDRS: '  ', AGENTBROWSER_ALLOW_LOOPBACK: 'no' }),
      env({ AGENTBROWSER_ALLOW_LOOPBACK: '0' }),
    ]) {
      const document = policyDocumentFromEnvironment(e);
      expect(document.policies.some((p) => p.ruleId === 'env.allowed-cidrs')).toBe(false);
      expect(document.policies.some((p) => p.ruleId === 'env.block-loopback')).toBe(true);
    }
  });
  it('refuses approval values the server would refuse at startup (review 3b F1)', () => {
    for (const bad of ['5', 'null', 'true', '"x"', '[]', '{"rules":5}']) {
      expect(() =>
        policyDocumentFromEnvironment(env({ AGENTBROWSER_APPROVAL_POLICY: bad }))
      ).toThrow(/Invalid operator approval policy/);
    }
  });
  it('surfaces startup errors: bad CIDRs, bad JSON, bad rules', () => {
    expect(() =>
      policyDocumentFromEnvironment(env({ AGENTBROWSER_ALLOWED_CIDRS: '10.0.0.0/99' }))
    ).toThrow(/Invalid allowedPrivateCIDRs CIDR/);
    expect(() => policyDocumentFromEnvironment(env({ AGENTBROWSER_APPROVAL_POLICY: '{' }))).toThrow(
      SyntaxError
    );
    expect(() =>
      policyDocumentFromEnvironment(
        env({ AGENTBROWSER_APPROVAL_POLICY: '{"rules":[{"id":"BAD ID","effect":"read"}]}' })
      )
    ).toThrow(/Invalid operator approval rule/);
  });
});
