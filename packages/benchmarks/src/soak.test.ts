/**
 * TDD Tests for the churn soak (TD-025)
 */

import { AgentBrowserService } from '@agentbrowser/api';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSoak, soakReport } from './soak';

// The cleanup-audit failure branches inside runSoak are unreachable against
// a healthy stack, so the tests flip passthrough-mock sabotage switches per
// test; every switch resets after its test.
const soakSabotage = vi.hoisted(() => ({
  leakedSessions: false,
  leakedEngineSessions: false,
  crashEntries: false,
}));

vi.mock('@agentbrowser/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentbrowser/api')>();
  class AuditedService extends actual.AgentBrowserService {
    override listSessions() {
      if (soakSabotage.leakedSessions) {
        return [
          super.listSessions()[0] ?? {
            sessionId: 'ses_ghost',
            status: 'active',
            engine: { name: 'fake-engine', version: '1.0.0' },
            createdAt: new Date(0).toISOString(),
            ttlMs: 0,
            idleTimeoutMs: 0,
            pages: 1,
          },
        ];
      }
      return super.listSessions();
    }

    override getCrashLog() {
      if (soakSabotage.crashEntries) {
        return [
          ...super.getCrashLog(),
          {
            sessionId: 'ses_crash',
            reason: 'engine-crash',
            timestamp: new Date(0).toISOString(),
          },
        ];
      }
      return super.getCrashLog();
    }
  }
  return { ...actual, AgentBrowserService: AuditedService };
});

vi.mock('@agentbrowser/testkit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentbrowser/testkit')>();
  class SoakFakeEngine extends actual.FakeEngine {
    override getSession(sessionId: string) {
      const session = super.getSession(sessionId);
      if (session !== undefined && soakSabotage.leakedEngineSessions) {
        return new Proxy(session, {
          get(target, property) {
            if (property === 'isClosed') {
              return () => false;
            }
            return Reflect.get(target, property, target);
          },
        });
      }
      return session;
    }
  }
  return { ...actual, FakeEngine: SoakFakeEngine };
});

describe('runSoak', () => {
  it('should complete a small soak with a clean audit', async () => {
    const result = await runSoak({ cycles: 25 });

    expect(result.pass).toBe(true);
    expect(result.leakedSessions).toBe(0);
    expect(result.leakedEngineSessions).toBe(0);
    expect(result.crashEntries).toBe(0);
  });

  it('should keep RSS growth bounded across a churn run', async () => {
    const result = await runSoak({ cycles: 100, maxRssGrowthBytes: 128 * 1024 * 1024 });

    expect(result.pass).toBe(true);
    expect(result.rssGrowthBytes).toBeLessThan(128 * 1024 * 1024);
  });

  it('should render a passing report', async () => {
    const report = soakReport(await runSoak({ cycles: 10 }));
    expect(report).toContain('10 cycles');
    expect(report).toContain('PASS soak');
  });
});

describe('cleanup audit detects leaks', () => {
  it('should flag a session that was never closed', async () => {
    const engine = new FakeEngine();
    const service = new AgentBrowserService({ engine });
    await service.createSession({ tenantId: 'leaky' });

    const leaked = service.listSessions().length;
    const engineLeaked = engine
      .getSessionIds()
      .filter((id) => engine.getSession(id)?.isClosed() === false).length;

    expect(leaked).toBe(1);
    expect(engineLeaked).toBe(1);
    await service.shutdown();
  });
});

describe('cleanup audit failure paths', () => {
  afterEach(() => {
    soakSabotage.leakedSessions = false;
    soakSabotage.leakedEngineSessions = false;
    soakSabotage.crashEntries = false;
  });

  it('should flag sessions that survive close', async () => {
    soakSabotage.leakedSessions = true;
    const result = await runSoak({ cycles: 2 });

    expect(result.pass).toBe(false);
    expect(result.leakedSessions).toBe(1);
    expect(result.failures).toContain('1 sessions survived close');
  });

  it('should flag engine sessions that survive close', async () => {
    soakSabotage.leakedEngineSessions = true;
    const result = await runSoak({ cycles: 2 });

    expect(result.pass).toBe(false);
    expect(result.leakedEngineSessions).toBe(2); // one per cycle
    expect(result.failures).toContain('2 engine sessions survived close');
  });

  it('should flag crash-log entries during a healthy soak', async () => {
    soakSabotage.crashEntries = true;
    const result = await runSoak({ cycles: 2 });

    expect(result.pass).toBe(false);
    expect(result.crashEntries).toBe(1);
    expect(result.failures).toContain('1 crash-log entries during a healthy soak');
  });

  it('should flag RSS growth beyond a budget no run can meet', async () => {
    const result = await runSoak({ cycles: 2, maxRssGrowthBytes: -1e12 });

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toMatch(/^RSS grew -?\d+ bytes \(max -1000000000000\)$/);
  });

  it('should render every failure line and a failing verdict', async () => {
    soakSabotage.leakedSessions = true;
    const report = soakReport(await runSoak({ cycles: 2 }));

    expect(report).toContain('FAIL 1 sessions survived close');
    expect(report).toContain('FAIL soak');
    expect(report).not.toContain('PASS soak');
  });
});
