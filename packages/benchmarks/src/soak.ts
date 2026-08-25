/**
 * Churn soak and cleanup verification (TD-025)
 *
 * Repeated create -> navigate -> observe -> act -> close cycles, then a
 * cleanup audit: no surviving sessions, no surviving engine sessions, no
 * crash-log entries, and bounded RSS growth.
 */

import { AgentBrowserService } from '@agentbrowser/api';
import { FakeEngine } from '@agentbrowser/testkit';

export interface SoakOptions {
  cycles?: number;
  /** Permitted RSS growth across the whole soak, in bytes. */
  maxRssGrowthBytes?: number;
}

export interface SoakResult {
  cycles: number;
  elapsedMs: number;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  rssGrowthBytes: number;
  leakedSessions: number;
  leakedEngineSessions: number;
  crashEntries: number;
  pass: boolean;
  failures: string[];
}

const DEFAULT_CYCLES = 1000;
/** Generous bound: in-memory stores plus allocator noise, no real leak. */
const DEFAULT_MAX_RSS_GROWTH = 256 * 1024 * 1024;

export async function runSoak(options: SoakOptions = {}): Promise<SoakResult> {
  const cycles = options.cycles ?? DEFAULT_CYCLES;
  const maxRssGrowth = options.maxRssGrowthBytes ?? DEFAULT_MAX_RSS_GROWTH;

  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  const failures: string[] = [];

  const rssBefore = process.memoryUsage().rss;
  const startedAt = performance.now();

  for (let cycle = 0; cycle < cycles; cycle++) {
    const sessionId = (await service.createSession({ tenantId: `soak-${cycle}` })).sessionId;
    const pageId = (await service.createPage(sessionId)).pageId;
    await service.navigate(sessionId, pageId, { url: 'https://soak.example.com' });
    await service.observe(sessionId, pageId, {});
    await service.act(sessionId, pageId, { action: 'press', key: 'Enter' });
    await service.closeSession(sessionId);
  }

  const elapsedMs = performance.now() - startedAt;
  const rssAfter = process.memoryUsage().rss;

  // Cleanup audit.
  const leakedSessions = service.listSessions().length;
  const leakedEngineSessions = engine.getSessionIds().filter((id) => {
    const session = engine.getSession(id);
    return session !== undefined && !session.isClosed();
  }).length;
  const crashEntries = service.getCrashLog().length;

  if (leakedSessions > 0) {
    failures.push(`${leakedSessions} sessions survived close`);
  }
  if (leakedEngineSessions > 0) {
    failures.push(`${leakedEngineSessions} engine sessions survived close`);
  }
  if (crashEntries > 0) {
    failures.push(`${crashEntries} crash-log entries during a healthy soak`);
  }

  const rssGrowth = rssAfter - rssBefore;
  if (rssGrowth > maxRssGrowth) {
    failures.push(`RSS grew ${rssGrowth} bytes (max ${maxRssGrowth})`);
  }

  await service.shutdown();

  return {
    cycles,
    elapsedMs,
    rssBeforeBytes: rssBefore,
    rssAfterBytes: rssAfter,
    rssGrowthBytes: rssGrowth,
    leakedSessions,
    leakedEngineSessions,
    crashEntries,
    pass: failures.length === 0,
    failures,
  };
}

/** Render the soak report. */
export function soakReport(result: SoakResult): string {
  const lines = [
    `${result.cycles} cycles in ${Math.round(result.elapsedMs)}ms`,
    `RSS ${Math.round(result.rssBeforeBytes / 1e6)}MB -> ${Math.round(
      result.rssAfterBytes / 1e6
    )}MB (growth ${Math.round(result.rssGrowthBytes / 1e6)}MB)`,
    `leaked sessions: ${result.leakedSessions}, engine sessions: ${result.leakedEngineSessions}, crashes: ${result.crashEntries}`,
  ];
  for (const failure of result.failures) {
    lines.push(`FAIL ${failure}`);
  }
  lines.push('');
  lines.push(result.pass ? 'PASS soak' : 'FAIL soak');
  return lines.join('\n');
}
