#!/usr/bin/env node
/**
 * Benchmark runner (TD-025)
 *
 *   bench  - latency benchmarks against the spec targets (service dispatch
 *            overhead, measured against FakeEngine: the "excluding
 *            site/network" targets)
 *   tasks  - 50 deterministic agent tasks (MVP gate: >= 45)
 *   real   - comparative benchmark: FakeEngine vs real Chromium on local
 *            fixture pages (ADR-010 gate data)
 *   soak   - session churn with cleanup and RSS audit
 *   all    - everything; exits non-zero if any gate fails
 */

import { AgentBrowserService } from '@agentbrowser/api';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { FakeEngine } from '@agentbrowser/testkit';
import { comparativeReport, runRealBenchmarks } from './compare.js';
import { evaluateTarget, sample, summarize } from './harness.js';
import type { BenchmarkResult } from './harness.js';
import { runSoak, soakReport } from './soak.js';
import { TASK_GATE, runTasks, taskReport } from './tasks.js';

const ITERATIONS = 50;

async function benchmarkLatencies(): Promise<boolean> {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });

  // Warm session creation: churn sessions against one warm service.
  const sessionSamples = await sample(async () => {
    const session = await service.createSession({ tenantId: 'bench' });
    await service.closeSession(session.sessionId);
  }, ITERATIONS);

  // Observation: one stable page, observed repeatedly.
  const obsSession = (await service.createSession({ tenantId: 'bench' })).sessionId;
  const obsPage = (await service.createPage(obsSession)).pageId;
  await service.navigate(obsSession, obsPage, { url: 'https://bench.example.com' });
  const observationSamples = await sample(
    () => service.observe(obsSession, obsPage, {}),
    ITERATIONS
  );

  // Action dispatch: untargeted press actions (no staleness interference).
  const actionSamples = await sample(
    () => service.act(obsSession, obsPage, { action: 'press', key: 'Enter' }),
    ITERATIONS
  );

  await service.shutdown();

  const results: BenchmarkResult[] = [
    evaluateTarget('sessionCreateWarm', sessionSamples),
    evaluateTarget('observation', observationSamples),
    evaluateTarget('actionDispatch', actionSamples),
  ];

  console.log('--- latency benchmarks ---');
  console.log(summarize(results));
  return results.every((result) => result.pass);
}

async function benchmarkTasks(): Promise<boolean> {
  const outcomes = await runTasks();
  const passed = outcomes.filter((outcome) => outcome.pass).length;

  console.log('--- agent task benchmark ---');
  console.log(taskReport(outcomes));
  return passed >= TASK_GATE;
}

async function soak(cycles: number): Promise<boolean> {
  const result = await runSoak({ cycles });

  console.log('--- churn soak ---');
  console.log(soakReport(result));
  return result.pass;
}

const command = process.argv[2] ?? 'all';
const soakCycles = Number.parseInt(process.argv[3] ?? '1000', 10);

async function compareReal(iterations: number): Promise<boolean> {
  console.log('--- comparative benchmark: FakeEngine vs playwright-chromium ---');
  const fake = await runRealBenchmarks({ engine: new FakeEngine(), iterations });
  const real = await runRealBenchmarks({
    engine: new PlaywrightChromiumEngine(),
    iterations,
  });
  console.log(comparativeReport([fake, real]));
  // The ADR-010 gate cares about task success on the real engine.
  return real.refLoop.successes === real.refLoop.attempts;
}

let ok = true;
if (command === 'real') {
  // 50 iterations by default: enough signal without CI noise; pass a count
  // explicitly for deeper sampling.
  ok = (await compareReal(process.argv[3] !== undefined ? soakCycles : 50)) && ok;
}
if (command === 'bench' || command === 'all') {
  ok = (await benchmarkLatencies()) && ok;
}
if (command === 'tasks' || command === 'all') {
  ok = (await benchmarkTasks()) && ok;
}
if (command === 'soak' || command === 'all') {
  ok = (await soak(Number.isInteger(soakCycles) ? soakCycles : 1000)) && ok;
}

if (!['bench', 'tasks', 'soak', 'all', 'real'].includes(command)) {
  console.error(`unknown command: ${command} (use bench | tasks | soak | real | all)`);
  process.exit(2);
}

process.exit(ok ? 0 : 1);
