import type { EnginePage } from '@agentbrowser/engine';
import type { Locator, Page } from 'playwright';
import { vi } from 'vitest';

/** The Playwright page behind an EnginePage (test-only seam: the engine exposes it for
 * diagnostics; the interface does not). Shared by the engine's test suites. */
export function backingPage(page: EnginePage): Page {
  return (page as unknown as { backingPage(): Page }).backingPage();
}

/**
 * Spy on Locator.ariaSnapshot so a suite can inject per-target behavior: the capture
 * callback receives 'body' or 'element' plus the options and may throw (injected
 * timeout), return a canned snapshot string, or return undefined to pass through to the
 * real implementation.
 */
export function interceptSnapshots(
  page: EnginePage,
  capture: (kind: 'body' | 'element', options: { timeout?: number }) => string | undefined
) {
  const body = backingPage(page).locator('body');
  const prototype = Object.getPrototypeOf(body) as Locator;
  const original = prototype.ariaSnapshot;
  return vi.spyOn(prototype, 'ariaSnapshot').mockImplementation(async function (
    this: Locator,
    options = {}
  ) {
    const captured = capture(this.toString() === body.toString() ? 'body' : 'element', options);
    if (typeof captured === 'string') return captured;
    return original.call(this, options);
  });
}
