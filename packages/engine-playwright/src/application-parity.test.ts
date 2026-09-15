import { qualifyApplicationParity } from '@agentbrowser/testkit';
import { it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

it('qualifies UI/API parity, lost outcomes, stale humans and broken UI on Chromium', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    await qualifyApplicationParity(engine);
  } finally {
    await engine.close();
  }
});
