import { expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

it('observes and acts on snapshot names requiring YAML quotes without dropping controls', async () => {
  const engine = new PlaywrightChromiumEngine();
  try {
    const page = await (await engine.createSession({})).newPage();
    await page.navigate({
      url: `data:text/html,${encodeURIComponent(`<button onclick="document.title='clicked'">Owner's choice: &quot;Save&quot; \\ draft</button><p role="status" aria-label="VERSION_CONFLICT: reload">Conflict</p>`)}`,
    });
    const observed = await page.observe({ mode: 'interactive' });
    expect(observed.elements.find((e) => e.role === 'status')?.name).toBe(
      'VERSION_CONFLICT: reload'
    );
    const button = observed.elements.find((e) => e.role === 'button');
    expect(button?.name).toBe('Owner\'s choice: "Save" \\ draft');
    expect(button?.ref).toBeDefined();
    await page.act({ type: 'click', target: { ref: button!.ref! } });
    expect((await page.observe({})).title).toBe('clicked');
  } finally {
    await engine.close();
  }
});
