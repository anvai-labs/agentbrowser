import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

/**
 * G1 (docs/agent-handoffs/AGENTBROWSER_UI_GAPS_2026-10-10.md): custom menu
 * controls with generic, duplicated accessible names ("Access: No access"
 * everywhere on GitHub's permission editor) must carry row/section context so
 * an agent can address them without HTML forensics.
 */
describe('formControls row context (G1)', () => {
  it('mints context from the enclosing row label and section heading', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: `data:text/html,${encodeURIComponent(
          '<body><main><h2>Repository permissions</h2><ul>' +
            '<li><strong>Contents</strong><button aria-haspopup="true">Access: No access</button></li>' +
            '<li><strong>Pull requests</strong><button aria-haspopup="true">Access: No access</button></li>' +
            '</ul><h2>Organization permissions</h2><ul>' +
            '<li><strong>Actions</strong><button aria-haspopup="true">Access: No access</button></li>' +
            '</ul></main></body>'
        )}`,
      });
      const { elements } = await page.observe({ include: ['formControls'] });

      const controls = elements.filter((e) => e.role === 'control');
      expect(controls).toHaveLength(3);
      // Every control has the SAME generic name — context is what separates them.
      expect(new Set(controls.map((c) => c.name)).size).toBe(1);
      expect(controls[0]?.context).toContain('Contents');
      expect(controls[1]?.context).toContain('Pull requests');
      // Section headings ride along when a preceding heading is found.
      expect(controls[0]?.context).toContain('Repository permissions');
      expect(controls[2]?.context).toContain('Organization permissions');
    } finally {
      await engine.close();
    }
  });

  it('omits context for controls with no enclosing row label', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<body><main><button aria-haspopup="true">Access: No access</button></main></body>',
      });
      const { elements } = await page.observe({ include: ['formControls'] });
      const control = elements.find((e) => e.role === 'control');
      expect(control).toBeDefined();
      expect(control?.context).toBeUndefined();
    } finally {
      await engine.close();
    }
  });
});
