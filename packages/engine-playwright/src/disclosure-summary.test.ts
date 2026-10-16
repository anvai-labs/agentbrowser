/**
 * Native disclosures (<details>/<summary>) in real Chromium.
 *
 * Playwright's aria snapshot has no role for <summary> (HTML-AAM: "No corresponding role"), so
 * its text folds into the parent group and observe used to mint no control for it: a driver
 * looking for name "Fixture controls" found only {role:"group", value:"Fixture controls"}.
 * observe now mints each details' first summary as role "html-summary" (HTML-AAM's computed
 * role; platform APIs expose it as an expandable button, never forced to ARIA "button") with its
 * accessible name and an `expanded` state from details.open, bound like any ref.
 */
import type { EnginePage } from '@agentbrowser/engine';
import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

const page = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

async function withPage<T>(html: string, run: (p: EnginePage) => Promise<T>): Promise<T> {
  const engine = new PlaywrightChromiumEngine();
  try {
    const p = await (await engine.createSession({ headless: true })).newPage();
    await p.navigate({ url: page(html) });
    return await run(p);
  } finally {
    await engine.close();
  }
}

const summaries = async (p: EnginePage) =>
  (await p.observe({})).elements.filter((el) => el.role === 'html-summary');

describe('native disclosures (details/summary) in observe', () => {
  it('reproduces the handoff fixture: the summary is a named control with expanded state', async () => {
    await withPage(
      '<details><summary>Fixture controls</summary><button>Example action</button></details>',
      async (p) => {
        const state = await p.observe({});
        const summary = state.elements.find(
          (el) => el.role === 'html-summary' && el.name === 'Fixture controls'
        );
        expect(summary).toMatchObject({ visible: true, enabled: true, expanded: false });
        expect(summary?.ref).toBeTruthy();
        // Closed content is not rendered, so its button is not an actionable control yet.
        expect(
          state.elements.some((el) => el.role === 'button' && el.name === 'Example action')
        ).toBe(false);
      }
    );
  }, 60_000);

  it('clicking the summary ref expands and collapses it; the revealed control appears', async () => {
    await withPage(
      '<details><summary>Fixture controls</summary><button>Example action</button></details>',
      async (p) => {
        const [closed] = await summaries(p);
        await p.act({ type: 'click', target: { ref: closed?.ref as string } });
        const opened = await p.observe({});
        expect(opened.elements.find((el) => el.role === 'html-summary')?.expanded).toBe(true);
        expect(
          opened.elements.some((el) => el.role === 'button' && el.name === 'Example action')
        ).toBe(true);
        const [again] = await summaries(p);
        await p.act({ type: 'click', target: { ref: again?.ref as string } });
        expect((await summaries(p))[0]?.expanded).toBe(false);
      }
    );
  }, 60_000);

  it('the keyboard toggles a focused summary (Enter and Space)', async () => {
    await withPage('<details><summary>Keys</summary><p>body</p></details>', async (p) => {
      const [first] = await summaries(p);
      await p.act({ type: 'press', key: 'Enter', target: { ref: first?.ref as string } });
      expect((await summaries(p))[0]?.expanded).toBe(true);
      const [second] = await summaries(p);
      await p.act({ type: 'press', key: ' ', target: { ref: second?.ref as string } });
      expect((await summaries(p))[0]?.expanded).toBe(false);
    });
  }, 60_000);

  it('nested disclosures: the inner summary appears once the outer opens, with its own state', async () => {
    await withPage(
      '<details><summary>Outer</summary><details><summary>Inner</summary><a href="#x">Deep link</a></details></details>',
      async (p) => {
        expect((await summaries(p)).map((s) => s.name)).toEqual(['Outer']);
        const [outer] = await summaries(p);
        await p.act({ type: 'click', target: { ref: outer?.ref as string } });
        const after = await summaries(p);
        expect(after.map((s) => [s.name, s.expanded])).toEqual([
          ['Outer', true],
          ['Inner', false],
        ]);
        await p.act({ type: 'click', target: { ref: after[1]?.ref as string } });
        expect((await summaries(p)).map((s) => [s.name, s.expanded])).toEqual([
          ['Outer', true],
          ['Inner', true],
        ]);
      }
    );
  }, 60_000);

  it('names unnamed and labelled summaries by accessible name; an empty summary is still targetable', async () => {
    await withPage(
      '<details><summary aria-label="More options">⋯</summary><p>a</p></details>' +
        '<details><summary><img alt="Settings" src="data:,"></summary><p>b</p></details>' +
        '<details><summary></summary><p>c</p></details>',
      async (p) => {
        const found = await summaries(p);
        expect(found.map((s) => s.name ?? '')).toEqual(['More options', 'Settings', '']);
        expect(found.every((s) => typeof s.ref === 'string')).toBe(true);
      }
    );
  }, 60_000);

  it('does not duplicate a summary that already has an explicit role, nor mint one for details without a summary', async () => {
    await withPage(
      '<details><summary role="button">Explicit</summary><p>a</p></details>' +
        '<details><p>no summary element</p></details>' +
        '<details open><summary>First</summary><summary>Second</summary><p>b</p></details>',
      async (p) => {
        const state = await p.observe({});
        expect(state.elements.filter((el) => el.name === 'Explicit').map((el) => el.role)).toEqual([
          'button',
        ]);
        // Only a details' FIRST summary is its disclosure control (HTML-AAM).
        expect((await summaries(p)).map((s) => [s.name, s.expanded])).toEqual([['First', true]]);
      }
    );
  }, 60_000);

  it('a summary ref from before a toggle is refused (current-ref protection)', async () => {
    await withPage('<details><summary>Stale check</summary><p>x</p></details>', async (p) => {
      const [before] = await summaries(p);
      await p.act({ type: 'click', target: { ref: before?.ref as string } });
      await p.observe({});
      const outcome = await p.act({ type: 'click', target: { ref: before?.ref as string } }).then(
        (result) => result.error?.code ?? 'ran',
        (error: { code?: string }) => error.code
      );
      // The engine refuses a ref from an older revision outright (the service layer reports
      // the same refusal as STALE_TARGET via its revision check); nothing toggles.
      expect(['STALE_TARGET', 'TARGET_NOT_FOUND']).toContain(outcome);
      expect((await summaries(p))[0]?.expanded).toBe(true);
    });
  }, 60_000);

  it('finds a summary inside a loaded iframe and binds it in that frame', async () => {
    await withPage(
      '<iframe title="embedded" srcdoc="<details><summary>Framed</summary><p>in frame</p></details>"></iframe>',
      async (p) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const [framed] = (await summaries(p)).filter((s) => s.name === 'Framed');
        expect(framed).toMatchObject({ expanded: false });
        await p.act({ type: 'click', target: { ref: framed?.ref as string } });
        expect((await summaries(p)).find((s) => s.name === 'Framed')?.expanded).toBe(true);
      }
    );
  }, 60_000);

  it('a hostile page that breaks built-ins changes nothing: names and state come from the browser', async () => {
    await withPage(
      '<details><summary>S</summary><p>x</p></details><button>Still here</button>' +
        '<script>Array.from = () => { throw new Error("hostile"); };' +
        'Array.prototype.map = () => [{ index: 0, name: { evil: 1 }, expanded: "x" }];' +
        'Object.defineProperty(HTMLDetailsElement.prototype, "open", { get() { throw new Error("hostile"); } });</script>',
      async (p) => {
        const state = await p.observe({});
        expect(state.elements.some((el) => el.name === 'Still here')).toBe(true);
        expect(state.elements.filter((el) => el.role === 'html-summary')).toEqual([
          expect.objectContaining({ name: 'S', expanded: false }),
        ]);
      }
    );
  }, 60_000);

  it('a script toggle is refused even when the details holds only text', async () => {
    await withPage('<details id="d"><summary>T</summary>Just text</details>', async (p) => {
      const [summary] = await summaries(p);
      await (p as unknown as { backingPage(): import('playwright').Page })
        .backingPage()
        .evaluate(() => {
          (document.getElementById('d') as HTMLDetailsElement).open = true;
        });
      const outcome = await p.act({ type: 'click', target: { ref: summary?.ref as string } }).then(
        (result) => result.error?.code ?? 'ran',
        (error: { code?: string }) => error.code
      );
      expect(outcome).toBe('STALE_TARGET');
    });
  }, 60_000);

  it('live content changing inside an open details does not make its summary stale', async () => {
    await withPage(
      '<details id="d" open><summary>Live</summary><span id="n">0</span></details>',
      async (p) => {
        const [summary] = await summaries(p);
        await (p as unknown as { backingPage(): import('playwright').Page })
          .backingPage()
          .evaluate(() => {
            (document.getElementById('n') as HTMLElement).textContent = '1';
          });
        await p.act({ type: 'click', target: { ref: summary?.ref as string } });
        expect((await summaries(p))[0]?.expanded).toBe(false);
      }
    );
  }, 60_000);

  it('switching include:["formControls"] does not bump the revision on a menu summary page', async () => {
    await withPage(
      '<details><summary aria-haspopup="menu">Menu</summary><div>items</div></details><button>B</button>',
      async (p) => {
        const first = (await p.observe({})).revision;
        const withControls = (await p.observe({ include: ['formControls'] })).revision;
        const again = (await p.observe({})).revision;
        expect([withControls, again]).toEqual([first, first]);
      }
    );
  }, 60_000);

  it('a summary toggled by page script since observe is refused as changed state', async () => {
    await withPage('<details id="d"><summary>Scripted</summary><p>x</p></details>', async (p) => {
      const [summary] = await summaries(p);
      await (p as unknown as { backingPage(): import('playwright').Page })
        .backingPage()
        .evaluate(() => {
          (document.getElementById('d') as HTMLDetailsElement).open = true;
        });
      const outcome = await p.act({ type: 'click', target: { ref: summary?.ref as string } }).then(
        (result) => result.error?.code ?? 'ran',
        (error: { code?: string }) => error.code
      );
      expect(outcome).toBe('STALE_TARGET');
    });
  }, 60_000);

  it('the cap counts only rendered summaries and a capped observation says so', async () => {
    const many = Array.from(
      { length: 210 },
      (_, i) =>
        `<details><summary>Outer ${i}</summary><details><summary>Inner ${i}</summary></details></details>`
    ).join('');
    await withPage(many, async (p) => {
      const state = await p.observe({});
      const found = state.elements.filter((el) => el.role === 'html-summary');
      expect(found).toHaveLength(200);
      expect(found.at(-1)?.name).toBe('Outer 199');
      expect(JSON.stringify(state)).toMatch(/disclosures? capped/);
    });
  }, 120_000);

  it('accessible names match Chromium for the tricky cases', async () => {
    const cases = [
      '<summary><h3>Title</h3><span>Sub</span></summary>',
      '<summary>Qty <input value="5" aria-label="quantity"></summary>',
      '<summary role="none">Presented</summary>',
      '<summary><span class="after">Base</span></summary>',
      '<summary>Visible <span style="display:none">HIDDEN</span> end</summary>',
      '<summary>T<style>.x{color:red}</style><script>var a=1</script></summary>',
      '<summary aria-labelledby="la">ignored</summary>',
      '<summary>Sum <button aria-label="BtnLabel">x</button></summary>',
      '<summary title="TitleName"></summary>',
      '<summary>a<br>b</summary>',
    ];
    await withPage(
      '<style>.after::after{content:" Extra"}</style>' +
        cases.map((c, i) => `<details data-i="${i}">${c}<p>.</p></details>`).join('') +
        '<details><summary role="foo button">Fallback</summary><p>.</p></details>' +
        // The labelledby target lives outside the (closed) details, as on real pages.
        '<span id="la" aria-label="LabelOfA">textA</span>',
      async (p) => {
        const page = (p as unknown as { backingPage(): import('playwright').Page }).backingPage();
        const cdp = await page.context().newCDPSession(page);
        const { nodes } = await cdp.send('Accessibility.getFullAXTree');
        const chromium = nodes
          .filter((n) => !n.ignored && n.role?.value === 'DisclosureTriangle')
          .map((n) => String(n.name?.value ?? ''));
        const ours = (await summaries(p)).map((s) => s.name ?? '');
        expect(ours).toEqual(chromium);
        // "foo button" resolves to the first valid role: one button, no disclosure row.
        const state = await p.observe({});
        expect(state.elements.filter((el) => el.name === 'Fallback').map((el) => el.role)).toEqual([
          'button',
        ]);
      }
    );
  }, 60_000);

  it('mints summaries with an empty or invalid role (Chromium still exposes them as disclosures)', async () => {
    await withPage(
      '<details><summary role="">Empty role</summary><p>a</p></details>' +
        '<details><summary role="bogus">Bogus role</summary><p>b</p></details>',
      async (p) => {
        expect((await summaries(p)).map((s) => s.name)).toEqual(['Empty role', 'Bogus role']);
      }
    );
  }, 60_000);

  it('does not double-mint a menu summary that formControls already mints', async () => {
    await withPage(
      '<details><summary aria-haspopup="menu">Menu</summary><div>items</div></details>',
      async (p) => {
        const state = await p.observe({ include: ['formControls'] });
        expect(state.elements.filter((el) => el.name === 'Menu')).toHaveLength(1);
      }
    );
  }, 60_000);

  it('validates page-function rows in Node (untrusted page data)', async () => {
    const { validateSummaryInfos } = await import('./index.js');
    const good = {
      index: 0,
      name: 'A',
      expanded: false,
      visible: true,
      explicitRole: false,
      hasPopup: false,
    };
    expect(validateSummaryInfos([good], 1)).toEqual({ valid: [good], dropped: 0 });
    // Wrong types, an out-of-range index and a duplicate index are dropped; extra rows beyond
    // the real match count count as dropped too.
    const result = validateSummaryInfos(
      [
        { ...good, name: { evil: 1 } },
        { ...good, index: 1 },
        { ...good, index: 1 },
        { ...good, index: 2, expanded: 'x' },
        { ...good, index: 9 },
      ],
      4
    );
    expect(result.valid.map((row) => row.index)).toEqual([1]);
    expect(result.dropped).toBe(4);
    expect(validateSummaryInfos('nope', 2)).toEqual({ valid: [], dropped: 2 });
  });
});
