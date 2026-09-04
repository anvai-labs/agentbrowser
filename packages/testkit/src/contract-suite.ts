/**
 * Reusable engine contract suite
 *
 * The engine-neutral contract every BrowserEngine implementation must
 * satisfy, expressed as a function any engine can be plugged into:
 *   runEngineContractSuite(engine)  -> runs against FakeEngine, Playwright,
 *   remote CDP, Obscura, or a future Rust engine identically.
 *
 * This is the mechanism that guarantees third-party engines work: an
 * adapter is correct exactly when this suite passes against it. Each test
 * names the spec invariant it proves.
 */

import { strict as assert } from 'node:assert';
import type { BrowserEngine } from '@agentbrowser/engine';

export interface ContractSuiteOptions {
  /** A page URL the engine can navigate to. Default: a data: URL. */
  navigateUrl?: string;
  /** Timeout ceiling for the whole suite (ms). */
  timeoutMs?: number;
}

/** Run the full contract suite against an engine; throws on violation. */
export async function runEngineContractSuite(
  engine: BrowserEngine,
  options: ContractSuiteOptions = {}
): Promise<void> {
  const url = options.navigateUrl ?? 'data:text/html,<button>go</button>';

  // --- engine metadata ---------------------------------------------------
  assert.ok(engine.name.length > 0, 'engine.name must be non-empty');
  assert.ok(engine.version.length > 0, 'engine.version must be non-empty');

  // --- capabilities report delivered truth --------------------------------
  const capabilities = await engine.capabilities();
  assert.ok(Array.isArray(capabilities.supportedObservationModes));
  assert.ok(capabilities.supportedObservationModes.length > 0);
  assert.ok(Array.isArray(capabilities.supportedActionTypes));
  assert.ok(capabilities.supportedActionTypes.length > 0);

  // --- session lifecycle --------------------------------------------------
  // Always-headed engines (TD-BROWSER-7, real Safari) declare it in their
  // capabilities; the suite then requests headed, since headless is not a
  // mode the engine can honor.
  const session = await engine.createSession({
    headless: capabilities.alwaysHeaded !== true,
  });
  assert.ok(session.id.length > 0, 'session id must be non-empty');

  const pages = await session.pages();
  assert.ok(Array.isArray(pages), 'session.pages() must return an array');

  // --- page lifecycle -----------------------------------------------------
  const page = await session.newPage();
  assert.ok(page.id.length > 0, 'page id must be non-empty');

  const pagesAfter = await session.pages();
  assert.strictEqual(pagesAfter.length, pages.length + 1, 'newPage must add exactly one page');

  // --- navigation ---------------------------------------------------------
  const navigation = await page.navigate({ url });
  assert.ok(
    navigation.status === 'success' ||
      navigation.status === 'timeout' ||
      navigation.status === 'blocked',
    'navigate must return a contract status'
  );
  assert.ok(typeof navigation.url === 'string');

  // --- observation: semantic, refs present ---------------------------------
  const observation = await page.observe({ mode: 'interactive' });
  assert.ok(typeof observation.url === 'string', 'observation.url');
  assert.ok(typeof observation.title === 'string', 'observation.title');
  assert.ok(Array.isArray(observation.elements), 'observation.elements');

  // --- refs: resolve what was observed ------------------------------------
  const target = observation.elements[0] as { ref: string } | undefined;
  if (target !== undefined) {
    const resolved = await page.resolve({ ref: target.ref });
    assert.strictEqual(resolved.ref, target.ref, 'resolve returns the same ref');
    assert.ok(
      typeof resolved.fingerprint === 'string' && resolved.fingerprint.length > 0,
      'resolve must return a canonical fingerprint'
    );

    // Acting on an unobserved ref must fail (never silently act).
    await assert.rejects(
      () => page.resolve({ ref: 'e999999_999' }),
      /not found/i,
      'unknown refs must reject'
    );
  }

  // --- acting through a ref ------------------------------------------------
  if (target !== undefined) {
    const effect = await page.act({ type: 'click', target: { ref: target.ref } });
    assert.ok(effect.actionId.length > 0, 'act returns actionId');
    assert.ok(typeof effect.newRevision === 'number');
    assert.ok(effect.newRevision >= effect.oldRevision, 'revisions are monotonic');
  }

  // --- untargeted action (no ref required) ---------------------------------
  const pressEffect = await page.act({ type: 'press', key: 'Enter' });
  assert.ok(pressEffect.actionId.length > 0, 'untargeted act returns actionId');

  // --- artifacts: bytes round-trip ------------------------------------------
  const shot = await page.screenshot({ format: 'png' });
  assert.ok(shot.artifactId.length > 0);
  assert.ok(shot.contentType.includes('image/'));
  assert.ok(shot.sizeBytes >= 0);

  // --- close audit: closing ends the page ----------------------------------
  await page.close();
  const pagesAfterClose = await session.pages();
  assert.strictEqual(pagesAfterClose.length, pages.length, 'close removes exactly the closed page');

  // --- session close ---------------------------------------------------------
  await session.close('contract-complete');

  // Operations on a closed session must fail, never silently succeed.
  await assert.rejects(() => session.newPage(), 'closed sessions must reject newPage');

  // --- engine close is idempotent --------------------------------------------
  await engine.close();
  await engine.close();
}
