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
});
