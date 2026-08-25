/**
 * TDD Tests for the churn soak (TD-025)
 */

import { AgentBrowserService } from '@agentbrowser/api';
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it } from 'vitest';
import { runSoak, soakReport } from './soak';

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
