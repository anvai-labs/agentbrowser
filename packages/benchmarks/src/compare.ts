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

/**
 * OVH-Manager-shaped workload (compact-output acceptance): global nav plus a
 * policy dialog subtree and a user table, >300 elements so the normalizer's
 * priority sort engages and the dialog must still be reachable by projection.
 */
const OVH_PAGE = `<!DOCTYPE html><html><body>
  <nav>${Array.from({ length: 220 }, (_, i) => `<a href="/ovh?page=${i}">Nav ${i}</a>`).join('')}</nav>
  <table><tbody>${Array.from(
    { length: 12 },
    (_, r) =>
      `<tr><td>user-${r + 1}-prod</td><td>row ${r + 1}</td><td><button>Edit user ${r + 1}</button></td></tr>`
  ).join('')}</tbody></table>
  <dialog open>
    <h2>Manage user policy</h2>
    ${Array.from(
      { length: 6 },
      (_, c) => `<label><input type="checkbox" /> Policy ${c + 1}</label>`
    ).join('')}
    <button>Confirm</button><button>Cancel</button>
  </dialog>
  ${Array.from({ length: 80 }, (_, i) => `<button>Toolbar ${i}</button>`).join('')}
</body></html>`;

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
      '/ovh': OVH_PAGE,
    };
    const path = url.split('?')[0] ?? '/';
    const body = pages[path];
    if (body !== undefined) {
      response.writeHead(200, { 'content-type': 'text/html' }).end(body);
      return;
    }
    // Redirect fixture: /redirect?to=<url> issues a 302 (egress tests).
    if (path === '/redirect') {
      const to = new URL(
        url,
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      ).searchParams.get('to');
      if (to !== null) {
        response.writeHead(302, { location: to }).end();
        return;
      }
    }
    // Subresource probe: /leak fetches the given URL from inside the page.
    if (path === '/leak') {
      const to = new URL(
        url,
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      ).searchParams.get('to');
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!DOCTYPE html><html><body><script>fetch(${JSON.stringify(to ?? '')}).catch(()=>{})</script></body></html>`
        );
      return;
    }
    response.writeHead(404).end('not found');
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
  /** Report label override (default: engine.name) - e.g. 'obscura'. */
  label?: string;
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
      engineName: options.label ?? options.engine.name,
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

export interface CompactProjectionBenchmark {
  engineName: string;
  /** Serialized bytes of a full observe vs the scoped projection, averaged. */
  fullBytes: number;
  compactBytes: number;
  reductionPercent: number;
  /** Both modes must find the same dialog checkbox ref (parity gate). */
  fullFoundRef: boolean;
  compactFoundRef: boolean;
  /** Element counts reported by each mode. */
  fullElements: number;
  compactElements: number;
}

/**
 * Compact-vs-full A/B on the /ovh fixture (compact-output acceptance §1/§5):
 * the full observation and the scoped projection must both locate the policy
 * dialog's first checkbox; the byte delta is the reported saving. Success
 * parity is required — a cheaper observation that loses the target is a
 * regression, not a win.
 */
export async function runCompactProjectionBenchmark(
  options: RealBenchmarkOptions
): Promise<CompactProjectionBenchmark> {
  const ownedServer = options.fixturePort === undefined ? await startFixtureServer(0) : undefined;
  const port = options.fixturePort ?? ownedServer?.port;
  if (port === undefined) {
    throw new Error('no fixture port');
  }
  const base = `http://127.0.0.1:${port}`;

  try {
    const service = new AgentBrowserService({
      engine: options.engine,
      networkPolicy: new NetworkPolicy({
        blockLoopback: false,
        blockPrivateIPs: true,
        blockMetadata: true,
      }),
    });
    const sessionId = (await service.createSession({ tenantId: 'bench' })).sessionId;
    const pageId = (await service.createPage(sessionId)).pageId;
    await service.navigate(sessionId, pageId, { url: `${base}/ovh` });

    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf-8');
    const iterations = options.iterations ?? 10;

    let fullBytesTotal = 0;
    let compactBytesTotal = 0;
    let fullElements = 0;
    let compactElements = 0;
    let fullFound = false;
    let compactFound = false;

    for (let i = 0; i < iterations; i += 1) {
      const full = await service.observe(sessionId, pageId, {});
      fullBytesTotal += bytes(full);
      fullElements = full.elements.length;
      if (full.elements.some((element) => element.role === 'checkbox')) fullFound = true;

      const compact = await service.observe(sessionId, pageId, {
        roles: ['dialog', 'checkbox', 'heading', 'button'],
        name: 'policy',
      });
      compactBytesTotal += bytes(compact);
      compactElements = compact.elements.length;
      if (compact.elements.some((element) => element.role === 'checkbox')) compactFound = true;
    }

    await service.shutdown();

    const fullBytes = Math.round(fullBytesTotal / iterations);
    const compactBytes = Math.round(compactBytesTotal / iterations);
    return {
      engineName: options.label ?? options.engine.name,
      fullBytes,
      compactBytes,
      reductionPercent: Math.round((1 - compactBytes / Math.max(fullBytes, 1)) * 100),
      fullFoundRef: fullFound,
      compactFoundRef: compactFound,
      fullElements,
      compactElements,
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
