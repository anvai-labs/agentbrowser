import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { ControlGrantSchema } from './control.js';
import {
  AGENT_CAPABILITIES,
  AGENT_MODE_IDS,
  AgentModeSchema,
  DEFAULT_AGENT_MODE,
  agentModeAllows,
  agentModeProfile,
  isAgentMode,
} from './mode-profile.js';

describe('trusted agent mode profiles', () => {
  it('has one closed registry for every documented mode', () => {
    expect(Object.isFrozen(AGENT_MODE_IDS)).toBe(true);
    expect(Object.isFrozen(AGENT_CAPABILITIES)).toBe(true);
    expect(AGENT_MODE_IDS).toEqual([
      'qa',
      'operations',
      'audit',
      'appsec',
      'bounty',
      'forms',
      'application',
    ]);
    expect(DEFAULT_AGENT_MODE).toBe('qa');
    expect(AGENT_MODE_IDS.every((mode) => agentModeProfile(mode).id === mode)).toBe(true);
  });

  it('uses capabilities from the canonical closed vocabulary without duplicates', () => {
    for (const mode of AGENT_MODE_IDS) {
      const capabilities = agentModeProfile(mode).capabilities;
      expect(new Set(capabilities).size).toBe(capabilities.length);
      expect(capabilities.every((capability) => AGENT_CAPABILITIES.includes(capability))).toBe(
        true
      );
    }
  });

  it('keeps specialized omissions explicit', () => {
    expect(agentModeAllows('qa', 'page.form')).toBe(true);
    expect(agentModeAllows('audit', 'page.form')).toBe(false);
    expect(agentModeAllows('audit', 'page.capture')).toBe(true);
    expect(agentModeProfile('bounty').capabilities).toEqual(
      agentModeProfile('appsec').capabilities
    );
    expect(agentModeProfile('application').capabilities).toEqual(['session.control']);
  });

  it('rejects caller-invented mode names', () => {
    expect(isAgentMode('forms')).toBe(true);
    expect(isAgentMode('admin')).toBe(false);
    expect(isAgentMode(undefined)).toBe(false);
    expect(Value.Check(AgentModeSchema, 'admin')).toBe(false);
    expect(
      Value.Check(ControlGrantSchema, {
        state: 'AGENT_ACTIVE',
        epoch: 1,
        busy: false,
        token: 'secret',
        mode: 'forms',
        cursor: {
          version: 1,
          serviceGeneration: 'aaaaaaaaaaaaaaaaaaaaaa',
          bindingGeneration: 'bbbbbbbbbbbbbbbbbbbbbb',
          sessionId: 'session',
          controlEpoch: 1,
          mode: 'forms',
          profileRevision: 1,
        },
      })
    ).toBe(true);
  });
});
