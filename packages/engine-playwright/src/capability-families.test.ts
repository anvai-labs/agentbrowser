import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

describe('family capability declarations', () => {
  it.each(['chromium', 'firefox', 'webkit'] as const)(
    '%s only advertises implemented PDF/CDP',
    async (browser) => {
      const engine = new PlaywrightChromiumEngine({ browser });
      const capabilities = await engine.capabilities();
      expect(capabilities.supportsCdp).toBe(browser === 'chromium');
      expect(capabilities.supportsPdf).toBe(browser === 'chromium');
      await engine.close();
    }
  );
});
