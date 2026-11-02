import { SessionCoordinator } from '@agentbrowser/core';
import { FakeEngine } from '@agentbrowser/testkit';
import { expect, it, vi } from 'vitest';
import { AgentBrowserService } from './service.js';

it('surfaces fingerprint seed warnings in create and owning-session status without values', async () => {
  const service = new AgentBrowserService({ engine: new FakeEngine() });
  try {
    const created = await service.createSession({
      cookies: [
        {
          name: 'cf_clearance',
          value: 'PRIVATE-FINGERPRINT-CANARY',
          domain: 'app.example.com',
          path: '/',
        },
      ],
    });
    expect(created.warnings?.join(' ')).toContain('fingerprint-bound');
    expect(created.warnings?.join(' ')).not.toContain('PRIVATE-FINGERPRINT-CANARY');
    expect(service.getSession(created.sessionId)?.warnings).toEqual(created.warnings);
    const ordinary = await service.createSession({
      cookies: [{ name: 'ordinary', value: 'PRIVATE-OTHER', domain: 'app.example.com', path: '/' }],
    });
    expect(ordinary.warnings).toBeUndefined();
  } finally {
    await service.shutdown();
  }
});

it('cleans warnings on close and does not transfer them to a reused textual session id', async () => {
  const coordinator = new SessionCoordinator();
  vi.spyOn(
    coordinator as unknown as { generateSessionId(): string },
    'generateSessionId'
  ).mockReturnValue('seed_warning_owner');
  const service = new AgentBrowserService({ engine: new FakeEngine(), coordinator });
  try {
    const first = await service.createSession({
      cookies: [{ name: 'cf_clearance', value: 'PRIVATE-FIRST', domain: 'app.test', path: '/' }],
    });
    expect(first.warnings?.join(' ')).toContain('fingerprint-bound');
    await service.closeSession(first.sessionId);
    const second = await service.createSession({
      cookies: [{ name: 'session', value: 'PRIVATE-SECOND', domain: 'app.test', path: '/' }],
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.warnings).toBeUndefined();
    expect(service.getSession(second.sessionId)?.warnings).toBeUndefined();
  } finally {
    await service.shutdown();
  }
});

it('derives warnings from the detached seed captured before engine allocation', async () => {
  const engine = new FakeEngine();
  const originalCreate = engine.createSession.bind(engine);
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(engine, 'createSession').mockImplementation(async (options) => {
    entered();
    await held;
    return originalCreate(options);
  });
  const service = new AgentBrowserService({ engine });
  const cookies = [{ name: 'cf_clearance', value: 'PRIVATE-SEED', domain: 'app.test', path: '/' }];
  const creating = service.createSession({ cookies });
  try {
    await ready;
    cookies[0]!.name = 'ordinary';
    cookies[0]!.domain = 'changed.test';
    release();
    const result = await creating;
    expect(result.warnings?.join(' ')).toContain('fingerprint-bound');
    expect(result.warnings?.join(' ')).not.toContain('PRIVATE-SEED');
    expect(service.getSession(result.sessionId)?.warnings).toEqual(result.warnings);
  } finally {
    release();
    await creating.catch(() => {});
    await service.shutdown();
  }
});
