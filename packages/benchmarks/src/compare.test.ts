/**
 * TDD Tests for the comparative benchmark (ADR-010)
 *
 * Real-engine numbers need real pages without external network: a local
 * fixture server supplies deterministic pages, and the benchmark service
 * runs with loopback allowed for those fixtures only. The harness is
 * engine-parameterized so the plumbing is testable against FakeEngine;
 * the real run injects PlaywrightChromiumEngine.
 */

import type {
  BrowserEngine,
  EnginePage,
  EngineSession,
  EngineSessionOptions,
} from '@agentbrowser/engine';
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

  it('should redirect /redirect?to= to the requested fixture page', async () => {
    const target = `http://127.0.0.1:${server.port}/links`;
    const response = await fetch(
      `http://127.0.0.1:${server.port}/redirect?to=${encodeURIComponent(target)}`
    );

    expect(response.status).toBe(200);
    expect(response.url).toBe(target);
    expect(await response.text()).toContain('Link Target 0');
  });

  it('should 404 a redirect without a target and unknown paths', async () => {
    const noTarget = await fetch(`http://127.0.0.1:${server.port}/redirect`);
    expect(noTarget.status).toBe(404);
    expect(await noTarget.text()).toBe('not found');

    const unknown = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('not found');
  });

  it('should serve the subresource probe page with the fetch target embedded', async () => {
    const to = `http://127.0.0.1:${server.port}/links`;
    const response = await fetch(
      `http://127.0.0.1:${server.port}/leak?to=${encodeURIComponent(to)}`
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<script>fetch(');
    expect(body).toContain(JSON.stringify(to));
  });

  it('should serve the probe page with an empty fetch target when none is given', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/leak`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('fetch("")');
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

  it('should reject when no fixture port can be resolved', async () => {
    await expect(
      runRealBenchmarks({
        engine: new FakeEngine(),
        fixturePort: null as unknown as number,
      })
    ).rejects.toThrow('no fixture port');
  });

  it('should complete and verify the ref loop when the engine serves the form fields', async () => {
    const server = await startFixtureServer(0);
    try {
      const result = await runRealBenchmarks({
        engine: new FormLoopEngine(),
        iterations: 3,
        fixturePort: server.port,
      });

      expect(result.refLoop.attempts).toBe(3);
      expect(result.refLoop.successes).toBe(3);
      // observe -> fill -> verify, every iteration
      expect(result.refLoop.actions).toBe(9);
    } finally {
      await server.stop();
    }
  });

  it('should count a failed verification when the fill never lands', async () => {
    const server = await startFixtureServer(0);
    try {
      const result = await runRealBenchmarks({
        engine: new FormLoopEngine(true),
        iterations: 2,
        fixturePort: server.port,
      });

      expect(result.refLoop.attempts).toBe(2);
      expect(result.refLoop.successes).toBe(0);
      // the fill still reports success; only the read-back verification fails
      expect(result.refLoop.actions).toBe(6);
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

/**
 * A FakeEngine that seeds the form fixture's labelled fields after every
 * navigation, so the ref-driven loop runs end to end: observe the First
 * name field, fill it by ref, read the value back, and verify. With
 * `dropFills` the success effect is kept but the value write is dropped,
 * exercising the loop's failed-verification path.
 */
class FormLoopEngine extends FakeEngine {
  private readonly dropFills: boolean;

  constructor(dropFills = false) {
    super();
    this.dropFills = dropFills;
  }

  override async createSession(options: EngineSessionOptions): Promise<EngineSession> {
    const session = await super.createSession(options);
    const dropFills = this.dropFills;
    return new Proxy(session, {
      get(target, property) {
        if (property === 'newPage') {
          return async (...args: Parameters<EngineSession['newPage']>) => {
            const page = await target.newPage(...args);
            return new Proxy(page, {
              get(pageTarget, pageProperty) {
                if (pageProperty === 'navigate') {
                  return async (request: Parameters<EnginePage['navigate']>[0]) => {
                    const result = await pageTarget.navigate(request);
                    pageTarget.setElements([
                      { role: 'textbox', name: 'First name', value: '' },
                      { role: 'textbox', name: 'Last name', value: '' },
                      { role: 'button', name: 'Apply', value: '' },
                    ]);
                    return result;
                  };
                }
                if (pageProperty === 'act' && dropFills) {
                  return async (action: Parameters<EnginePage['act']>[0]) => {
                    if (action.type === 'fill') {
                      // keep the success effect, drop the value write
                      return pageTarget.act({ ...action, value: undefined });
                    }
                    return pageTarget.act(action);
                  };
                }
                return Reflect.get(pageTarget, pageProperty, pageTarget);
              },
            }) as EnginePage;
          };
        }
        return Reflect.get(target, property, target);
      },
    }) as EngineSession;
  }
}
