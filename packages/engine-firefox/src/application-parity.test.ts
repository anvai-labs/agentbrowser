import { qualifyApplicationParity } from '@agentbrowser/testkit';
import { it } from 'vitest';
import { FirefoxBiDiEngine } from './index.js';

it.skipIf(!process.env.AGENTBROWSER_FIREFOX_EXECUTABLE)(
  'qualifies UI/API parity, lost outcomes, stale humans and broken UI on native Firefox',
  async () => {
    const engine = new FirefoxBiDiEngine({
      executablePath: process.env.AGENTBROWSER_FIREFOX_EXECUTABLE!,
    });
    try {
      await qualifyApplicationParity(engine);
    } finally {
      await engine.close();
    }
  }
);
