/**
 * Comparative benchmarks (ADR-010 gate data)
 *
 * Measures the real engine against deterministic local fixture pages - no
 * external network - so the numbers are reproducible. The harness compares
 * any engines side by side; the ADR-010 decision (invest in a Rust engine
 * or not) consumes exactly this report.
 *
 * The benchmark service allows loopback egress for the fixture origin only:
 * the fixtures are the test's own pages, and private ranges plus cloud
 * metadata stay blocked.
 */

import { createServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { AgentBrowserService } from '@agentbrowser/api';
import type { BrowserEngine } from '@agentbrowser/engine';
import { NetworkPolicy } from '@agentbrowser/policy';
import { evaluateTarget, percentile, sample } from './harness.js';
import type { BenchmarkResult } from './harness.js';

// ---------------------------------------------------------------------------
// Fixture pages
// ---------------------------------------------------------------------------

/** Ten labelled links. */
const LINKS_PAGE = `<!DOCTYPE html><html><body><main>
  <h1>Links</h1>
  ${Array.from({ length: 10 }, (_, i) => `<a href="/form?page=${i}">Link Target ${i}</a>`).join('\n  ')}
</main></body></html>`;

/** A form with labelled inputs and a submit button. */
const FORM_PAGE = `<!DOCTYPE html><html><body><main>
  <h1>Form</h1>
  <form>
    <label>First name <input aria-label="First name" type="text" /></label>
    <label>Last name <input aria-label="Last name" type="text" /></label>
    <button type="button" id="go">Apply</button>
  </form>
</main></body></html>`;

/** One hundred buttons: an observation-latency workload. */
const LONG_PAGE = `<!DOCTYPE html><html><body><main>
  <h1>Long</h1>
  ${Array.from({ length: 100 }, (_, i) => `<button>Button ${i}</button>`).join('\n  ')}
</main></body></html>`;

export interface FixtureServer {
  port: number;
  stop(): Promise<void>;
}

/** Serve the deterministic fixture pages on loopback. */
export function startFixtureServer(port = 0): Promise<FixtureServer> {
  const server: Server = createServer((request, response) => {
    const url = request.url ?? '/';
    const pages: Record<string, string> = {
      '/links': LINKS_PAGE,
      '/form': FORM_PAGE,
      '/long': LONG_PAGE,
    };
    const body = pages[url.split('?')[0] ?? '/'];
    if (body === undefined) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const bound = server.address() as AddressInfo;
      resolve({
        port: bound.port,
        stop: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Benchmark flow
// ---------------------------------------------------------------------------

export interface EngineBenchmark {
  engineName: string;
  sessionCreate: BenchmarkResult;
  observation: BenchmarkResult;
  action: BenchmarkResult;
  refLoop: {
    attempts: number;
    successes: number;
    actions: number;
    elapsedMs: number;
  };
}

export interface RealBenchmarkOptions {
  engine: BrowserEngine;
  iterations?: number;
  fixturePort?: number;
  /** Start a fixture server when no port is given. */
  startServer?: boolean;
}

/**
 * Run the comparative flow against one engine on the fixture pages:
 * the latency trio plus a ref-driven observe -> fill -> verify loop, which
 * is the agent workflow the ADR-010 task-success gate consumes.
 */
export async function runRealBenchmarks(options: RealBenchmarkOptions): Promise<EngineBenchmark> {
  const iterations = options.iterations ?? 20;
  const ownedServer = options.fixturePort === undefined ? await startFixtureServer(0) : undefined;
  const port = options.fixturePort ?? ownedServer?.port;
  if (port === undefined) {
    throw new Error('no fixture port');
  }
  const base = `http://127.0.0.1:${port}`;

  try {
    const service = new AgentBrowserService({
      engine: options.engine,
      // Fixtures live on loopback by construction; the benchmark allows the
      // loopback origin only, private ranges and metadata stay blocked.
      networkPolicy: new NetworkPolicy({
        blockLoopback: false,
        blockPrivateIPs: true,
        blockMetadata: true,
      }),
    });

    // Warm session creation.
    const sessionSamples = await sample(async () => {
      const session = await service.createSession({ tenantId: 'bench' });
      await service.closeSession(session.sessionId);
    }, iterations);

    // Observation against the long fixture page.
    const obsSession = (await service.createSession({ tenantId: 'bench' })).sessionId;
    const obsPage = (await service.createPage(obsSession)).pageId;
    await service.navigate(obsSession, obsPage, { url: `${base}/long` });
    const observationSamples = await sample(
      () => service.observe(obsSession, obsPage, {}),
      iterations
    );

    // Action dispatch overhead (untargeted; no site interaction).
    const actionSamples = await sample(
      () => service.act(obsSession, obsPage, { action: 'press', key: 'Enter' }),
      iterations
    );

    // Ref-driven agent loop on the form fixture: observe -> fill by ref ->
    // verify the value landed. Scored like the task benchmark.
    const loopStarted = performance.now();
    let attempts = 0;
    let successes = 0;
    let actions = 0;
    for (let i = 0; i < iterations; i++) {
      attempts += 1;
      try {
        const loopSession = (await service.createSession({ tenantId: 'bench' })).sessionId;
        const loopPage = (await service.createPage(loopSession)).pageId;
        await service.navigate(loopSession, loopPage, { url: `${base}/form` });

        const observation = await service.observe(loopSession, loopPage, {});
        actions += 1;
        const field = observation.elements.find(
          (element) => element.role === 'textbox' && element.name === 'First name'
        );
        if (!field) {
          throw new Error('first-name field not observed');
        }

        await service.act(loopSession, loopPage, {
          action: 'fill',
          target: { ref: field.ref },
          value: `bench-${i}`,
        });
        actions += 1;

        const after = await service.observe(loopSession, loopPage, {});
        actions += 1;
        const filled = after.elements.find(
          (element) => element.role === 'textbox' && element.name === 'First name'
        );
        if (filled?.value !== `bench-${i}`) {
          throw new Error(`fill not verified: ${String(filled?.value)}`);
        }
        successes += 1;
        await service.closeSession(loopSession);
      } catch {
        // Counted as a failed attempt; the report carries the rate.
      }
    }

    await service.shutdown();

    return {
      engineName: options.engine.name,
      sessionCreate: evaluateTarget('sessionCreateWarm', sessionSamples),
      observation: evaluateTarget('observation', observationSamples),
      action: evaluateTarget('actionDispatch', actionSamples),
      refLoop: {
        attempts,
        successes,
        actions,
        elapsedMs: performance.now() - loopStarted,
      },
    };
  } finally {
    await ownedServer?.stop();
  }
}

/** Render engines side by side. */
export function comparativeReport(benchmarks: EngineBenchmark[]): string {
  const lines: string[] = ['# Comparative benchmark (ADR-010 gate data)', ''];

  for (const benchmark of benchmarks) {
    lines.push(`## ${benchmark.engineName}`);
    lines.push('');
    lines.push(
      `sessionCreateWarm  p50=${benchmark.sessionCreate.p50.toFixed(1)}ms p95=${benchmark.sessionCreate.p95.toFixed(1)}ms (${benchmark.sessionCreate.pass ? 'within' : 'EXCEEDS'} target)`
    );
    lines.push(
      `observation       p50=${benchmark.observation.p50.toFixed(1)}ms p95=${benchmark.observation.p95.toFixed(1)}ms (${benchmark.observation.pass ? 'within' : 'EXCEEDS'} target)`
    );
    lines.push(
      `actionDispatch    p50=${benchmark.action.p50.toFixed(1)}ms p95=${benchmark.action.p95.toFixed(1)}ms (${benchmark.action.pass ? 'within' : 'EXCEEDS'} target)`
    );
    lines.push(
      `ref-loop          ${benchmark.refLoop.successes}/${benchmark.refLoop.attempts} succeeded, ${benchmark.refLoop.actions} actions in ${Math.round(benchmark.refLoop.elapsedMs)}ms`
    );
    lines.push('');
  }

  return lines.join('\n');
}

export { percentile };
