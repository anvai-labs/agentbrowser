import { expect, it } from 'vitest';
import { deploymentModeFromEnvironment } from './cdp-config.js';
import {
  hostHintFromHostname,
  operatorCdpFromEnvironment,
  profileHintFromEnvironment,
} from './cdp-startup.js';

it('leaves ordinary startup disabled', () => {
  expect(operatorCdpFromEnvironment({})).toBeUndefined();
});
it.each([
  { AGENTBROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222' },
  { AGENTBROWSER_CDP_ALLOW_UNENFORCED_EGRESS: 'true' },
  {
    AGENTBROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222',
    AGENTBROWSER_CDP_ALLOW_UNENFORCED_EGRESS: 'yes',
  },
  {
    AGENTBROWSER_CDP_ENDPOINT: 'http://secret:password@remote.example:9222/private',
    AGENTBROWSER_CDP_ALLOW_UNENFORCED_EGRESS: 'true',
  },
])('fails closed for partial or invalid trusted configuration', (env) => {
  expect(() => operatorCdpFromEnvironment(env)).toThrow();
  try {
    operatorCdpFromEnvironment(env);
  } catch (error) {
    expect(String(error)).not.toMatch(/secret|password|remote\.example|\/private/);
  }
});
it('snapshots the acknowledged capability', () => {
  const env = {
    AGENTBROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222',
    AGENTBROWSER_CDP_ALLOW_UNENFORCED_EGRESS: 'true',
  };
  const config = operatorCdpFromEnvironment(env);
  env.AGENTBROWSER_CDP_ENDPOINT = 'http://other.invalid';
  expect(config).toEqual({ endpoint: 'http://127.0.0.1:9222', allowUnenforcedEgress: true });
  expect(Object.isFrozen(config)).toBe(true);
});
it('parses an explicit deployment boundary without truthy-string fallback', () => {
  expect(deploymentModeFromEnvironment({})).toBe('local');
  expect(deploymentModeFromEnvironment({ AGENTBROWSER_HOSTED: 'true' })).toBe('hosted');
  expect(deploymentModeFromEnvironment({ AGENTBROWSER_HOSTED: 'false' })).toBe('local');
  expect(() => deploymentModeFromEnvironment({ AGENTBROWSER_HOSTED: 'ture' })).toThrow();
});

it('does not accept truthy strings as trusted embedding acknowledgements or modes', async () => {
  const { cdpAttachAdmission } = await import('./floor.js');
  expect(
    cdpAttachAdmission({ operatorCdp: { allowUnenforcedEgress: 'false' as unknown as boolean } }, [
      'one',
    ])
  ).toBe('egress');
  expect(() => cdpAttachAdmission({ deploymentMode: 'hosetd' as 'hosted' }, ['one'])).toThrow(
    'Invalid deployment mode'
  );
});

it('reduces the daemon hostname to a bounded first-label host hint (ADR-034)', () => {
  expect(hostHintFromHostname('daemon.example.com')).toBe('daemon');
  expect(hostHintFromHostname('ops-macbook.local')).toBe('ops-macbook');
  expect(hostHintFromHostname('')).toBeUndefined();
});

it('parses the operator profile hint from the environment, refusing path-like values', () => {
  expect(profileHintFromEnvironment({})).toEqual({});
  expect(profileHintFromEnvironment({ AGENTBROWSER_CDP_PROFILE_HINT: 'Operator' })).toEqual({
    profileHint: 'Operator',
  });
  const refused = profileHintFromEnvironment({
    AGENTBROWSER_CDP_PROFILE_HINT: '/Users/op/agentbrowser-operator-profile',
  });
  expect(refused.profileHint).toBeUndefined();
  expect(refused.warning).toMatch(/AGENTBROWSER_CDP_PROFILE_HINT/);
});
