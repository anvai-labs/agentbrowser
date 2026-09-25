import type { Page } from 'playwright';
import { expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

it('refuses internal browser error documents even when goto resolves', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const session = await engine.createSession();
    const page = await session.newPage();
    const native = (page as unknown as { backingPage(): Page }).backingPage();
    await page.navigate({ url: 'data:text/html,<button>Old page button</button>' });
    const before = await page.observe({});
    vi.spyOn(native, 'goto').mockResolvedValue(null);
    const url = vi.spyOn(native, 'url');
    for (const errorUrl of [
      'chrome-error://chromewebdata/',
      'edge-error://edgewebdata/',
      'about:neterror?private-value',
      'about:certerror',
    ]) {
      url.mockReturnValue(errorUrl);
      await expect(page.navigate({ url: 'https://example.com/' })).rejects.toMatchObject({
        code: 'INTERNAL',
        retryable: false,
        details: { reason: 'browser_error_document' },
      });
    }
    const after = await page.observe({});
    expect(after.revision).toBeGreaterThan(before.revision ?? 0);
    url.mockReturnValue('https://example.com/redirected');
    await expect(page.navigate({ url: 'https://example.com/' })).resolves.toMatchObject({
      status: 'success',
      url: 'https://example.com/redirected',
    });
  } finally {
    vi.restoreAllMocks();
    await engine.close();
  }
});

it('preserves explicit policy denial and successful HTTP error documents', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const session = await engine.createSession();
    const page = await session.newPage();
    const native = (page as unknown as { backingPage(): Page }).backingPage();
    const goto = vi.spyOn(native, 'goto');
    goto.mockResolvedValue({ headers: () => ({ 'x-agentbrowser-blocked': '1' }) } as never);
    await expect(page.navigate({ url: 'https://example.com/' })).resolves.toMatchObject({
      status: 'blocked',
    });
    goto.mockResolvedValue({ headers: () => ({}), status: () => 503 } as never);
    vi.spyOn(native, 'url').mockReturnValue('https://example.com/maintenance');
    await expect(page.navigate({ url: 'https://example.com/' })).resolves.toMatchObject({
      status: 'success',
      url: 'https://example.com/maintenance',
    });
  } finally {
    vi.restoreAllMocks();
    await engine.close();
  }
});
