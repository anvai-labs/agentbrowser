import { afterEach, describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';
import {
  classifyNestedContentUnobservable,
  type NestedContentUnobservableInput,
} from './nested-content.js';

function baseInput(
  overrides: Partial<NestedContentUnobservableInput> = {}
): NestedContentUnobservableInput {
  return {
    childFrameCount: 1,
    frames: [{ contributedElements: 0, bodyTextLength: 0, domNodeCount: 0 }],
    hasLargeVisibleIframeSlot: false,
    topElementCount: 3,
    ...overrides,
  };
}

describe('classifyNestedContentUnobservable', () => {
  it('does not fire without child frames', () => {
    expect(
      classifyNestedContentUnobservable(
        baseInput({ childFrameCount: 0, frames: [], hasLargeVisibleIframeSlot: false })
      )
    ).toBe(false);
  });

  it('branch 1: fires when a frame holds real content but contributed zero elements', () => {
    expect(
      classifyNestedContentUnobservable(
        baseInput({
          frames: [{ contributedElements: 0, bodyTextLength: 400, domNodeCount: 10 }],
        })
      )
    ).toBe(true);
    expect(
      classifyNestedContentUnobservable(
        baseInput({
          frames: [{ contributedElements: 0, bodyTextLength: 5, domNodeCount: 300 }],
        })
      )
    ).toBe(true);
  });

  it('branch 1: ignores frames that contributed elements or hold only trivial content', () => {
    expect(
      classifyNestedContentUnobservable(
        baseInput({
          frames: [{ contributedElements: 4, bodyTextLength: 400, domNodeCount: 300 }],
        })
      )
    ).toBe(false);
    expect(
      classifyNestedContentUnobservable(
        baseInput({
          frames: [{ contributedElements: 0, bodyTextLength: 40, domNodeCount: 3 }],
        })
      )
    ).toBe(false);
  });

  it('branch 2: fires for a large visible placeholder slot over a sparse shell', () => {
    expect(classifyNestedContentUnobservable(baseInput({ hasLargeVisibleIframeSlot: true }))).toBe(
      true
    );
  });

  it('branch 2: never fires for hidden/zero-size slots (analytics iframe)', () => {
    expect(classifyNestedContentUnobservable(baseInput({ hasLargeVisibleIframeSlot: false }))).toBe(
      false
    );
  });

  it('branch 2: never fires when the top document observed as fully empty (SPA case)', () => {
    expect(
      classifyNestedContentUnobservable(
        baseInput({ hasLargeVisibleIframeSlot: true, topElementCount: 0 })
      )
    ).toBe(false);
  });

  it('branch 2: never fires when the shell is not sparse', () => {
    expect(
      classifyNestedContentUnobservable(
        baseInput({ hasLargeVisibleIframeSlot: true, topElementCount: 60 })
      )
    ).toBe(false);
  });

  it('branch 2: never fires when any frame document is unknown or non-empty', () => {
    expect(
      classifyNestedContentUnobservable(
        baseInput({
          hasLargeVisibleIframeSlot: true,
          frames: [
            { contributedElements: 0, bodyTextLength: 0, domNodeCount: 0 },
            { contributedElements: 0, bodyTextLength: undefined, domNodeCount: undefined },
          ],
          childFrameCount: 2,
        })
      )
    ).toBe(false);
    expect(
      classifyNestedContentUnobservable(
        baseInput({
          hasLargeVisibleIframeSlot: true,
          frames: [{ contributedElements: 0, bodyTextLength: 80, domNodeCount: 4 }],
        })
      )
    ).toBe(false);
  });
});

// Real-Chromium coverage for the detection wiring (mirrors spa-capture.test.ts
// data:-URL style). TD-BROWSER-17 ask 2: observe must SAY nested content is
// unobservable instead of reading as "nothing here".
describe('nested content unobservable marker (real Chromium)', () => {
  let engine: PlaywrightChromiumEngine | undefined;

  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  it('fires when a same-origin iframe holds real content that contributes no elements', async () => {
    engine = new PlaywrightChromiumEngine();
    const session = await engine.createSession({ headless: true });
    const page = await session.newPage();
    // The frame carries a content-rich document whose accessibility tree has
    // no interactive elements (plain text in divs): the frame traversal folds
    // nothing from it even though the pane plainly holds content.
    const paneText = 'Tunnel status healthy connectors attached metrics streaming. '.repeat(10);
    const html =
      `<body><button aria-label="Go">Go</button>` +
      `<iframe srcdoc='<body><div>${paneText}</div></body>' title="pane"></iframe></body>`;
    await page.navigate({ url: `data:text/html,${html}` });

    const obs = await page.observe({ mode: 'interactive' });

    expect(obs.degraded).toBe(true);
    expect(obs.degradedReason).toBe('nested_content_unobservable');
    // Additive marker: no frame refs minted, element list is the shell only.
    expect(obs.elements.map((element) => element.ref)).toEqual([expect.stringMatching(/^e\d+_0$/)]);
  }, 30_000);

  it('does not fire on a page without iframes', async () => {
    engine = new PlaywrightChromiumEngine();
    const session = await engine.createSession({ headless: true });
    const page = await session.newPage();
    await page.navigate({
      url: 'data:text/html,<body><button aria-label="Go">Go</button><a href="#x">Link</a></body>',
    });

    const obs = await page.observe({ mode: 'interactive' });

    expect(obs.elements.length).toBeGreaterThan(0);
    expect(obs.degraded).toBeUndefined();
    expect(obs.degradedReason).toBeUndefined();
  }, 30_000);

  it('does not fire for a hidden blank analytics iframe on a busy page', async () => {
    engine = new PlaywrightChromiumEngine();
    const session = await engine.createSession({ headless: true });
    const page = await session.newPage();
    const nav = Array.from(
      { length: 24 },
      (_v, i) => `<button aria-label="n${i}">n${i}</button>`
    ).join('');
    await page.navigate({
      // Classic analytics shape: display:none / 0x0 about:blank frame, no body.
      url: `data:text/html,<body>${nav}<iframe style="display:none" src="about:blank"></iframe></body>`,
    });

    const obs = await page.observe({ mode: 'interactive' });

    expect(obs.elements.length).toBeGreaterThanOrEqual(24);
    expect(obs.degraded).toBeUndefined();
    expect(obs.degradedReason).toBeUndefined();
  }, 30_000);
});
