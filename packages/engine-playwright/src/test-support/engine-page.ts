import type { EnginePage } from '@agentbrowser/engine';
import { PlaywrightChromiumEngine } from '../index.js';

/**
 * The engine suites' shared page harness: one headless session + fresh page navigated
 * to a data: URL of the given HTML; the engine closes when `run` settles (including on
 * failure — no leaked Chromium). The canonical form for single-page scenarios; suites
 * that need the session object or multiple pages keep their own bootstrap.
 *
 * NOTE: src/test-support is excluded from the package tsconfig (the repo convention),
 * so this file is NOT type-checked — keep its types trivial.
 */
export async function withPage<T>(html: string, run: (p: EnginePage) => Promise<T>): Promise<T> {
  const engine = new PlaywrightChromiumEngine();
  try {
    const p = await (await engine.createSession({ headless: true })).newPage();
    await p.navigate({ url: `data:text/html,${encodeURIComponent(html)}` });
    return await run(p);
  } finally {
    await engine.close();
  }
}
