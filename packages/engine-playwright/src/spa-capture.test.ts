import { afterEach, describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

// Real-Chromium coverage for the SPA-capture robustness signals. Mirrors the
// live-browser style of action-contract.test.ts (data: URL fixtures).
describe('SPA capture robustness (real Chromium)', () => {
  let engine: PlaywrightChromiumEngine | undefined;

  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  it('flags empty-snapshot-nonempty-dom: aria tree empty but DOM has content', async () => {
    engine = new PlaywrightChromiumEngine();
    const session = await engine.createSession({ headless: true });
    const page = await session.newPage();
    // Text directly in <body> (no interactive/role elements): the accessibility
    // snapshot surfaces only static text (0 parsed elements) while innerText is
    // long - the empty-but-successful-snapshot case.
    const filler = 'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(20);
    await page.navigate({ url: `data:text/html,<body>${filler}</body>` });

    const obs = await page.observe({ mode: 'interactive' });

    expect(obs.elements.length).toBe(0);
    expect(obs.degraded).toBe(true);
    expect(obs.degradedReason).toBe('empty-snapshot-nonempty-dom');
  }, 30_000);

  it('does not flag a normal interactive page', async () => {
    engine = new PlaywrightChromiumEngine();
    const session = await engine.createSession({ headless: true });
    const page = await session.newPage();
    await page.navigate({ url: 'data:text/html,<body><button aria-label="Go">Go</button></body>' });

    const obs = await page.observe({ mode: 'interactive' });

    expect(obs.elements.length).toBeGreaterThan(0);
    expect(obs.degraded).toBeUndefined();
    expect(obs.degradedReason).toBeUndefined();
  }, 30_000);

  it('degraded DOM fallback surfaces role widgets with names on snapshot timeout', async () => {
    engine = new PlaywrightChromiumEngine();
    // snapshotTimeoutMs:1 forces the ariaSnapshot to time out on a node-heavy
    // page, driving the getContentElements() DOM fallback deterministically.
    const session = await engine.createSession({ headless: true, snapshotTimeoutMs: 1 });
    const page = await session.newPage();
    const noise = '<span>x</span>'.repeat(3000);
    const html = `<body>${noise}<div role="combobox" aria-label="Country">US</div><div role="tab">Home</div></body>`;
    await page.navigate({ url: `data:text/html,${html}` });

    const obs = await page.observe({ mode: 'interactive' });

    expect(obs.degraded).toBe(true);
    expect(obs.degradedReason).toBe('aria-snapshot-timeout');
    const combobox = obs.elements.find((element) => element.role === 'combobox');
    expect(combobox).toBeDefined();
    expect(combobox?.name).toBe('Country');
    expect(obs.elements.some((element) => element.role === 'tab')).toBe(true);
  }, 30_000);
});
