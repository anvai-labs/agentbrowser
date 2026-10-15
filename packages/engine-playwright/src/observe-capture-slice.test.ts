/**
 * F2 review: a node that changes between being resolved and having its aria snapshot captured
 * must not make one observation wait out the whole snapshot envelope. Each element's capture is
 * bounded to a short slice and degrades to document evidence on a miss.
 */
import { expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

it('an element renamed mid-observation costs at most a capture slice, not the envelope', async () => {
  const engine = new PlaywrightChromiumEngine({ snapshotTimeoutMs: 5_000 });
  try {
    const session = await engine.createSession({ headless: true });
    const page = await session.newPage();
    // The button's accessible name changes every millisecond, so a capture that looks the node
    // up again by role and name keeps missing it.
    await page.navigate({
      url:
        'data:text/html,<body><button id="b">Status 0</button>' +
        '<button>Stable</button><script>let n=0;' +
        'setInterval(()=>{document.getElementById("b").textContent="Status "+(++n)},1)' +
        '</script></body>',
    });
    for (let round = 0; round < 3; round += 1) {
      const started = performance.now();
      const observation = await page.observe({ mode: 'interactive' });
      const elapsed = performance.now() - started;
      expect(observation.elements.some((element) => element.name === 'Stable')).toBe(true);
      // The envelope is 5 s; a miss is bounded to one 500 ms slice per element.
      expect(elapsed).toBeLessThan(2_500);
    }
  } finally {
    await engine.close();
  }
}, 60_000);
