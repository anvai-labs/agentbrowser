import { describe, expect, it } from 'vitest';
import { sharedEngine } from './test-support/shared-engine.js';

const engine = sharedEngine();

/**
 * TD-BROWSER-18 gap 3: the `state` include widens element-state population,
 * not the schema. Elements the role-gated reads miss (a toggle whose
 * snapshot role is `button` carrying aria-checked — the dogfood case) get
 * their ARIA state; fill-down only, and default observations stay
 * byte-identical because `state` mints no rows.
 */
describe('observe include:["state"] (real Chromium)', () => {
  const STATE_PAGE =
    'data:text/html,' +
    encodeURIComponent(
      '<div role="button" aria-checked="true" aria-label="Dark mode">Dark mode</div>' +
        '<div role="button" aria-checked="mixed" aria-label="Mixed mode">Mixed mode</div>' +
        '<div role="button" aria-expanded="false" aria-label="Advanced">Advanced</div>' +
        '<div role="combobox" aria-label="Pick one" aria-disabled="true" tabindex="0">Pick one</div>'
    );

  it('fills aria state outside the role gates and stays revision-stable', async () => {
    let session: EngineSession | undefined;
    try {
      session = await engine.createSession({ headless: true });
      const page = await session.newPage();
      await page.navigate({ url: STATE_PAGE });

      const plain = await page.observe({});
      const nameOf = (state: { elements: Array<{ name?: string }> }, name: string) =>
        state.elements.find((element) => element.name === name);

      // Default observation: the residual hole is visible — role `button`
      // widgets carry no checked/expanded state.
      const plainDark = nameOf(plain, 'Dark mode');
      expect(plainDark).toBeDefined();
      expect('checked' in (plainDark ?? {})).toBe(false);

      const withState = await page.observe({ include: ['state'] });
      expect(nameOf(withState, 'Dark mode')?.checked).toBe(true);
      expect(nameOf(withState, 'Advanced')?.expanded).toBe(false);
      // aria-disabled fills `enabled: false` over a truthy native read.
      expect(nameOf(withState, 'Pick one')?.enabled).toBe(false);
      // `mixed` reads as unknown (key absent), never false.
      expect('checked' in (nameOf(withState, 'Mixed mode') ?? {})).toBe(false);

      // The include is an overlay, not page state: alternating include sets
      // on a static page holds one revision (state mints no rows).
      const plainAgain = await page.observe({});
      expect(withState.revision).toBe(plain.revision);
      expect(plainAgain.revision).toBe(plain.revision);
    } finally {
      await session?.close();
    }
  });
});
