import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

/**
 * Enrichment invariants (adversarial review rounds 6-12): these are the
 * EMPIRICAL specs for how opt-in enrichment (include:["formControls"]) may
 * interact with the revision machinery. Rounds 9-11 shipped "fixes" that
 * silently never applied; round 12 proved the bug by measuring behavior.
 * These tests are that measurement, permanent: a fix that doesn't hold the
 * invariant fails here regardless of what the code looks like.
 */
describe('enrichment invariants (real Chromium)', () => {
  const pageWithControls = `data:text/html,${encodeURIComponent(
    '<body><main><h2>Repository permissions</h2><ul>' +
      '<li><strong>Contents</strong><span data-automation-id="m1">Access: No access</span></li>' +
      '<li><strong>Pull requests</strong><span data-automation-id="m2">Access: No access</span></li>' +
      '</ul></main></body>'
  )}`;

  it('INJECT-1: toggling include formControls never bumps the revision on a static page', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: pageWithControls });

      const plain1 = await page.observe({});
      const withControls = await page.observe({ include: ['formControls'] });
      const plain2 = await page.observe({});
      const withControls2 = await page.observe({ include: ['formControls'] });

      // Every alternation must hold the SAME revision: enrichment is an
      // overlay, not page state. A bump invalidates every held ref.
      expect(withControls.revision).toBe(plain1.revision);
      expect(plain2.revision).toBe(plain1.revision);
      expect(withControls2.revision).toBe(plain1.revision);
      // And the minted controls ARE present in the include observations.
      expect(
        withControls.elements.filter((e) => e.role === 'control').length
      ).toBeGreaterThanOrEqual(2);
      expect(plain2.elements.filter((e) => e.role === 'control')).toHaveLength(0);
    } finally {
      await engine.close();
    }
  });

  it('INJECT-2: repeated same-include observations are revision-stable', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({ url: pageWithControls });
      const first = await page.observe({ include: ['formControls'] });
      const second = await page.observe({ include: ['formControls'] });
      expect(second.revision).toBe(first.revision);
      // Refs identical: same elements, same ordinals, same revision.
      expect(second.elements.map((e) => e.ref)).toEqual(first.elements.map((e) => e.ref));
    } finally {
      await engine.close();
    }
  });

  it('INJECT-3: enrichment appearing under a CONSTANT include set bumps the revision (lazy mount)', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      // One control initially; a second mounts lazily after first observe.
      await page.navigate({
        url: `data:text/html,${encodeURIComponent(
          '<body><main><ul><li><strong>Contents</strong><span data-automation-id="m1">Access: No access</span></li></ul></main>' +
            '<script>setTimeout(() => {' +
            'const li = document.createElement("li");' +
            'li.innerHTML = \'<strong>Pull requests</strong><span data-automation-id="m2">Access: No access</span>\';' +
            'document.querySelector("ul").appendChild(li);}, 300);</script></body>'
        )}`,
      });
      const first = await page.observe({ include: ['formControls'] });
      // Deterministic (round-15/F6): poll until the minted count actually
      // grows — a fixed wall-clock sleep raced the in-page timer under CI
      // load and failed spuriously.
      const countControls = async (): Promise<number> =>
        (await page.observe({ include: ['formControls'] })).elements.filter(
          (e) => e.role === 'control'
        ).length;
      const deadline = Date.now() + 10_000;
      let mounted = false;
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        if ((await countControls()) > 1) {
          mounted = true;
          break;
        }
      }
      expect(mounted).toBe(true);
      const second = await page.observe({ include: ['formControls'] });
      // Same include set + a new minted control = a real page change: the
      // revision MUST bump (round-8/F2's lazy-mount scenario).
      expect(second.revision).toBeGreaterThan(first.revision);
    } finally {
      await engine.close();
    }
  });

  it('INJECT-4: fileInputs toggles never bump the revision on a static page', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<body><main><input type="file" id="f1"><button>Go</button></main></body>',
      });
      const plain1 = await page.observe({});
      const withFiles = await page.observe({ include: ['fileInputs'] });
      const plain2 = await page.observe({});
      expect(withFiles.revision).toBe(plain1.revision);
      expect(plain2.revision).toBe(plain1.revision);
      expect(
        withFiles.elements.filter((e) => e.role === 'fileinput').length
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await engine.close();
    }
  });
});
