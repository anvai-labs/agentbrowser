import type { AuthorizationRequest, Authorizer } from '@agentbrowser/policy-engine';
import { LegacyAuthorizer } from '@agentbrowser/policy-engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

// TD-BROWSER-15 phase 1 (capabilities): what a session requests is granted
// through the Authorizer. The legacy authorizer grants everything, as today.

function denying(action: AuthorizationRequest['action']): Authorizer {
  const legacy = new LegacyAuthorizer({});
  return {
    version: 'test',
    decide: (request) =>
      request.action === action
        ? { allowed: false, reason: `${action} is not granted`, ruleMatched: `test.${action}` }
        : legacy.decide(request),
  };
}

describe('capability grants through the Authorizer', () => {
  it.each([
    ['downloads', { allowDownloads: true }],
    ['serviceWorkers', { allowServiceWorkers: true }],
    ['cookie.seed', { cookies: [{ name: 'a', value: 'b', domain: 'example.com', path: '/' }] }],
    ['session.headed', { headless: false }],
  ] as const)('refuses a session requesting %s when it is not granted', async (action, extra) => {
    const engine = new FakeEngine();
    const create = vi.spyOn(engine, 'createSession');
    const service = new AgentBrowserService({ engine, authorizer: denying(action) });
    await expect(service.createSession({ tenantId: 't1', ...extra })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: {
        rule: `test.${action}`,
        policyDecision: { allowed: false, ruleMatched: `test.${action}` },
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('does not ask about capabilities a session does not request', async () => {
    const decide = vi.fn(new LegacyAuthorizer({}).decide.bind(new LegacyAuthorizer({})));
    const service = new AgentBrowserService({
      engine: new FakeEngine(),
      authorizer: { version: 'spy', decide },
    });
    await service.createSession({ tenantId: 't1', allowServiceWorkers: false, cookies: [] });
    expect(decide).not.toHaveBeenCalled();
  });

  it('refuses cookie export when it is not granted', async () => {
    const service = new AgentBrowserService({
      engine: new FakeEngine(),
      authorizer: denying('cookie.export'),
    });
    const { sessionId } = await service.createSession({ tenantId: 't1' });
    await expect(service.getSessionCookies(sessionId)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { rule: 'test.cookie.export' },
    });
  });

  it('grants everything with the default (legacy) authorizer, as before', async () => {
    const service = new AgentBrowserService({ engine: new FakeEngine() });
    const { sessionId } = await service.createSession({
      tenantId: 't1',
      allowDownloads: true,
      allowServiceWorkers: true,
      headless: false,
      cookies: [{ name: 'a', value: 'b', domain: 'example.com', path: '/' }],
    });
    await expect(service.getSessionCookies(sessionId)).resolves.toBeDefined();
  });
});
