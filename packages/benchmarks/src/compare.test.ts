/**
 * TDD Tests for the comparative benchmark (ADR-010)
 *
 * Real-engine numbers need real pages without external network: a local
 * fixture server supplies deterministic pages, and the benchmark service
 * runs with loopback allowed for those fixtures only. The harness is
 * engine-parameterized so the plumbing is testable against FakeEngine;
 * the real run injects PlaywrightChromiumEngine.
 */

import type { BrowserEngine } from '@agentbrowser/engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer } from './compare';
import type { FixtureServer } from './compare';
import { comparativeReport, runRealBenchmarks } from './compare';

describe('fixture server', () => {
  let server: FixtureServer;

  beforeEach(async () => {
    server = await startFixtureServer(0);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should serve deterministic pages on loopback', async () => {
    for (const [path, marker] of [
      ['/links', 'Link Target 9'],
      ['/form', 'First name'],
      ['/long', 'Button 99'],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(marker);
    }
  });
});

describe('runRealBenchmarks (plumbing, against FakeEngine)', () => {
  it('should run the full flow and produce latencies', async () => {
    const server = await startFixtureServer(0);
    try {
      const result = await runRealBenchmarks({
        engine: new FakeEngine(),
        iterations: 3,
        fixturePort: server.port,
      });

      expect(result.sessionCreate.samples).toHaveLength(3);
      expect(result.observation.samples).toHaveLength(3);
      expect(result.action.samples).toHaveLength(3);
      expect(result.refLoop.actions).toBeGreaterThan(0);
      expect(result.engineName).toBe('fake-engine');
    } finally {
      await server.stop();
    }
  });

  it('should complete the ref-driven loop on real fixture pages', async () => {
    const server = await startFixtureServer(0);
    try {
      const result = await runRealBenchmarks({
        engine: new FakeEngine(),
        iterations: 2,
        fixturePort: server.port,
      });

      // The loop runs and scores honestly: every iteration is an attempt,
      // and failures are counted (FakeEngine serves synthetic elements, not
      // the fixture HTML, so the real-engine run carries the success signal).
      expect(result.refLoop.attempts).toBe(2);
      expect(result.refLoop.successes).toBeLessThanOrEqual(result.refLoop.attempts);
    } finally {
      await server.stop();
    }
  });
});

describe('comparativeReport', () => {
  it('should render engines side by side with percentiles', () => {
    const report = comparativeReport([
      {
        engineName: 'fake-engine',
        sessionCreate: { samples: [1, 2], pass: true, p50: 1, p95: 2 },
        observation: { samples: [1, 2], pass: true, p50: 1, p95: 2 },
        action: { samples: [1, 2], pass: true, p50: 1, p95: 2 },
        refLoop: { attempts: 10, successes: 10, actions: 40, elapsedMs: 100 },
      },
      {
        engineName: 'playwright-chromium',
        sessionCreate: { samples: [300, 900], pass: true, p50: 300, p95: 900 },
        observation: { samples: [80, 200], pass: true, p50: 80, p95: 200 },
        action: { samples: [40, 90], pass: true, p50: 40, p95: 90 },
        refLoop: { attempts: 10, successes: 10, actions: 40, elapsedMs: 5000 },
      },
    ]);

    expect(report).toContain('fake-engine');
    expect(report).toContain('playwright-chromium');
    expect(report).toContain('sessionCreateWarm');
    expect(report).toContain('ref-loop');
    expect(report).toContain('10/10');
  });
});
