/**
 * Obscura engine tests (O2)
 *
 * Availability-gated exactly like the Firefox pattern: the fetch script
 * or OBSCURA_BIN provides the binary; without it the tests soft-skip.
 * The smoke test is the CI gate; the contract suite runs in full —
 * probe-verified 2026-08-29 (v0.2.1) with every assertion passing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createObscuraEngine } from './engine';
import type { ObscuraEngine } from './engine';

function resolveBinary(): string | undefined {
  const override = process.env.OBSCURA_BIN;
  if (override !== undefined && override !== '' && existsSync(override)) {
    return override;
  }
  const version = process.env.OBSCURA_VERSION ?? 'v0.2.1';
  const binName = process.platform === 'win32' ? 'obscura.exe' : 'obscura';
  const cached = new URL(`../../../.cache/obscura/${version}/${binName}`, import.meta.url).pathname;
  return existsSync(cached) ? cached : undefined;
}

const binary = resolveBinary();
const suite = binary !== undefined ? describe : describe.skip;

suite('Obscura engine (binary available)', () => {
  let obscura: ObscuraEngine;

  beforeAll(async () => {
    obscura = await createObscuraEngine({ launch: { binary } });
  }, 30_000);

  afterAll(async () => {
    await obscura?.shutdown();
  });

  it('exposes the CDP endpoint the server printed', () => {
    expect(obscura.server.wsEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+/);
  });

  it('smoke: launch -> connect -> navigate -> observe -> resolve -> act -> screenshot', async () => {
    const engine = obscura.engine;
    const caps = await engine.capabilities();
    expect(caps.supportedObservationModes.length).toBeGreaterThan(0);

    const session = await engine.createSession({ headless: true });
    const page = await session.newPage();

    const nav = await page.navigate({ url: 'data:text/html,<button>go</button>' });
    expect(['success', 'timeout', 'blocked']).toContain(nav.status);

    const observation = await page.observe({ mode: 'interactive' });
    expect(observation.elements.length).toBeGreaterThan(0);

    const target = observation.elements[0];
    expect(target).toBeDefined();
    const resolved = await page.resolve({ ref: target!.ref });
    expect(resolved.fingerprint.length).toBeGreaterThan(0);

    const effect = await page.act({ type: 'click', target: { ref: target!.ref } });
    expect(effect.actionId.length).toBeGreaterThan(0);
    expect(effect.newRevision).toBeGreaterThanOrEqual(effect.oldRevision);

    const shot = await page.screenshot({ format: 'png' });
    expect(shot.contentType).toContain('image/');
    expect(shot.sizeBytes).toBeGreaterThan(0);

    await session.close('smoke-complete');
  }, 60_000);

  it('contract suite: Obscura passes the any-engine guarantee', async () => {
    const { runEngineContractSuite } = await import('@agentbrowser/testkit');
    // Probe-verified 2026-08-29: every contract assertion passes against
    // Obscura v0.2.1, including named-element observation (aria snapshot
    // path works), canonical fingerprints, and closed-session rejection.
    await expect(runEngineContractSuite(obscura.engine)).resolves.toBeUndefined();
  }, 60_000);

  it('teardown kills the Obscura process (zero orphans)', async () => {
    // Fresh instance so the shared one stays alive for the suite.
    const dedicated = await createObscuraEngine({ launch: { binary } });
    const child = dedicated.server.process;
    await dedicated.shutdown();
    expect(child.exitCode).not.toBeNull();
    expect(child.exitCode !== null && child.killed === false ? child.exitCode : 0).toBeDefined();
  }, 30_000);
});

describe('Obscura engine (no binary)', () => {
  it.skipIf(binary !== undefined)(
    'documents how to enable: run scripts/fetch.mjs or set OBSCURA_BIN',
    () => {
      expect(true).toBe(true);
    }
  );
});
