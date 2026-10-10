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
        url: 'data:text/html,<body><main><ul><li><button aria-haspopup="true">Access: No access</button></li><li><button aria-haspopup="true">Access: No access</button></li></ul></main></body>',
      });
      const { elements } = await page.observe({ include: ['formControls'] });
      const control = elements.find((e) => e.role === 'control');
      expect(control).toBeDefined();
      expect(control?.context).toBeUndefined();
    } finally {
      await engine.close();
    }
  });

  it('excludes the control own subtree from row-label candidates (review F2)', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: `data:text/html,${encodeURIComponent(
          '<body><main><ul>' +
            '<li><button aria-haspopup="true"><strong>Access: No access</strong></button><strong>Contents</strong></li>' +
            '<li><button aria-haspopup="true"><strong>Access: No access</strong></button><strong>Pull requests</strong></li>' +
            '</ul></main></body>'
        )}`,
      });
      const { elements } = await page.observe({ include: ['formControls'] });
      const contexts = elements.filter((e) => e.role === 'control').map((e) => e.context);
      expect(contexts).toContain('Contents');
      expect(contexts).toContain('Pull requests');
      // The generic inner <strong> never becomes the context.
      expect(contexts).not.toContain('Access: No access');
    } finally {
      await engine.close();
    }
  });

  it('finds the heading of an enclosing preceding <section> (review F3)', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: `data:text/html,${encodeURIComponent(
          '<body><main><h2>Account</h2>' +
            '<section><h2>Notifications</h2><ul>' +
            '<li><strong>Email</strong><button aria-haspopup="true">Access: No access</button></li>' +
            '<li><strong>Web</strong><button aria-haspopup="true">Access: No access</button></li>' +
            '</ul></section></main></body>'
        )}`,
      });
      const { elements } = await page.observe({ include: ['formControls'] });
      const contexts = elements.filter((e) => e.role === 'control').map((e) => e.context);
      expect(contexts).toContain('Email — Notifications');
      expect(contexts).not.toContain('Email — Account');
    } finally {
      await engine.close();
    }
  });

  it('derives dt row labels for controls inside dd, and honors aria-labelledby (review F4)', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: `data:text/html,${encodeURIComponent(
          '<body><main><dl>' +
            '<dt>Contents</dt><dd><button aria-haspopup="true">Access: No access</button></dd>' +
            '<dt>Pull requests</dt><dd><button aria-haspopup="true">Access: No access</button></dd>' +
            '</dl><span id="lbl-a">Issues</span><button aria-haspopup="true" aria-labelledby="lbl-a">Access: No access</button></main></body>'
        )}`,
      });
      const { elements } = await page.observe({ include: ['formControls'] });
      const contexts = elements.filter((e) => e.role === 'control').map((e) => e.context);
      expect(contexts).toContain('Contents');
      expect(contexts).toContain('Pull requests');
      expect(contexts).toContain('Issues');
    } finally {
      await engine.close();
    }
  });

  it('skips aria-labelledby sources that repeat the generic name (round-2/F1)', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: `data:text/html,${encodeURIComponent(
          '<body><main><ul>' +
            '<li><strong>Contents</strong><span id="v1">Access: No access</span><button aria-haspopup="true" aria-labelledby="v1"><span>Access: No access</span></button></li>' +
            '<li><strong>Pull requests</strong><span id="v2">Access: No access</span><button aria-haspopup="true" aria-labelledby="v2"><span>Access: No access</span></button></li>' +
            '</ul></main></body>'
        )}`,
      });
      const { elements } = await page.observe({ include: ['formControls'] });
      const contexts = elements.filter((e) => e.role === 'control').map((e) => e.context);
      // The labelledby span repeats the generic name: skipped, the row's
      // <strong> supplies the label instead.
      expect(contexts).toContain('Contents');
      expect(contexts).toContain('Pull requests');
      expect(contexts).not.toContain('Access: No access');
    } finally {
      await engine.close();
    }
  });

  it('a headingless section inherits no heading from a preceding sibling section (round-2/F2)', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: `data:text/html,${encodeURIComponent(
          '<body><main>' +
            '<section><h2>Repository permissions</h2><ul><li><strong>Actions</strong><button aria-haspopup="true">Access: No access</button></li><li><strong>Metadata</strong><button aria-haspopup="true">Access: No access</button></li></ul></section>' +
            '<section><ul><li><strong>Email</strong><button aria-haspopup="true">Access: No access</button></li><li><strong>Web</strong><button aria-haspopup="true">Access: No access</button></li></ul></section>' +
            '</main></body>'
        )}`,
      });
      const { elements } = await page.observe({ include: ['formControls'] });
      const contexts = elements.filter((e) => e.role === 'control').map((e) => e.context);
      expect(contexts).toContain('Actions — Repository permissions');
      // Second section has no heading of its own: context stays row-only,
      // never falsely claiming the previous section.
      expect(contexts).toContain('Email');
      expect(contexts).not.toContain('Email — Repository permissions');
    } finally {
      await engine.close();
    }
  });

  it('multi-dd groups never borrow another row label from the dl (round-2/F5)', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: `data:text/html,${encodeURIComponent(
          '<body><main><dl>' +
            '<dt>Alpha</dt><dd><strong>Note</strong></dd><dd><button aria-haspopup="true">Access: No access</button></dd>' +
            '<dt>Beta</dt><dd><button aria-haspopup="true">Access: No access</button></dd>' +
            '</dl></main></body>'
        )}`,
      });
      const { elements } = await page.observe({ include: ['formControls'] });
      const contexts = elements.filter((e) => e.role === 'control').map((e) => e.context);
      expect(contexts).toContain('Beta');
      // The multi-dd control's preceding sibling is a dd, not a dt: no row
      // label — never "Note" from Alpha's row.
      expect(contexts).not.toContain('Note');
    } finally {
      await engine.close();
    }
  });

  it('normalizes whitespace in labels and skips unique-named controls (review F5/F6)', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: `data:text/html,${encodeURIComponent(
          '<body><main><ul>' +
            '<li><strong>Deploy\n   keys</strong><button aria-haspopup="true">Access: No access</button></li>' +
            '<li><strong>Other</strong><button aria-haspopup="true">Access: No access</button></li>' +
            '<li><strong>Solo row</strong><button aria-haspopup="true">A uniquely named menu</button></li>' +
            '</ul></main></body>'
        )}`,
      });
      const { elements } = await page.observe({ include: ['formControls'] });
      const controls = elements.filter((e) => e.role === 'control');
      const contexts = controls.map((e) => e.context);
      // Whitespace-normalized, single-line contexts; both duplicated-name
      // controls carry their row labels.
      expect(contexts).toContain('Deploy keys');
      expect(contexts).toContain('Other');
      // A unique name needs no context: no bytes spent.
      const unique = controls.find((e) => e.name === 'A uniquely named menu');
      expect(unique?.context).toBeUndefined();
    } finally {
      await engine.close();
    }
  });
});
