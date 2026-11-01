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
      expect(capabilities.coordinateInput === true).toBe(browser === 'chromium');
      expect(capabilities.supportedActionTypes.includes('clickAt')).toBe(browser === 'chromium');
      await engine.close();
    }
  );
  it('permits trusted adapters to disable unqualified coordinate support', async () => {
    const engine = new PlaywrightChromiumEngine({ coordinateInput: false });
    try {
      const capabilities = await engine.capabilities();
      expect(capabilities.coordinateInput).not.toBe(true);
      expect(capabilities.supportedActionTypes).not.toContain('clickAt');
      expect(capabilities.supportedActionTypes).not.toContain('uploadAt');
    } finally {
      await engine.close();
    }
  });
});
