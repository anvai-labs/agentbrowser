import { describe, expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

/**
 * Scope-projection metadata (compact-output increment 2): the flattened a11y
 * observation records block-local nesting depth and snapshot-block identity so
 * a later scope-by-ref slice can be computed from the flat list. Stamping is
 * invisible by contract — flat top-level elements carry neither field.
 */
describe('element depth and block metadata', () => {
  it('stamps depth for dialog subtree descendants and not for siblings', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<body><button>Before</button><dialog open><button>Confirm</button><button>Cancel</button></dialog><button>After</button></body>',
      });
      const { elements } = await page.observe({});

      const before = elements.find((e) => e.role === 'button' && e.name === 'Before');
      const confirm = elements.find((e) => e.role === 'button' && e.name === 'Confirm');
      const after = elements.find((e) => e.role === 'button' && e.name === 'After');
      expect(before).toBeDefined();
      expect(confirm).toBeDefined();
      expect(after).toBeDefined();

      // Flat top-level buttons stay byte-identical: no depth, no block.
      expect(before?.depth).toBeUndefined();
      expect(after?.depth).toBeUndefined();
      // Dialog descendants are one level deeper than the dialog itself.
      const dialog = elements.find((e) => e.role === 'dialog');
      expect(dialog?.depth).toBeUndefined();
      expect(confirm?.depth).toBe((dialog?.depth ?? 0) + 1);

      // Document order survives: Confirm sits between Before and After.
      const ordinal = (ref: string) => Number.parseInt(ref.split('_')[1] ?? '', 10);
      expect(ordinal(confirm!.ref)).toBeGreaterThan(ordinal(before!.ref));
      expect(ordinal(after!.ref)).toBeGreaterThan(ordinal(confirm!.ref));
    } finally {
      await engine.close();
    }
  });

  it('stamps block for child-frame content and keeps depth frame-local', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: "data:text/html,<body><button>Main</button><iframe srcdoc='<button>Framed</button>'></iframe></body>",
      });
      const { elements } = await page.observe({});

      const main = elements.find((e) => e.role === 'button' && e.name === 'Main');
      const framed = elements.find((e) => e.role === 'button' && e.name === 'Framed');
      expect(main).toBeDefined();
      expect(framed).toBeDefined();

      // Main frame is block 0 (absent); merged frame content is block 1 with
      // its own depth scale (the frame body's buttons are top-level there).
      expect(main?.block).toBeUndefined();
      expect(framed?.block).toBe(1);
      expect(framed?.depth).toBeUndefined();
    } finally {
      await engine.close();
    }
  });

  it('keeps repeated observations of an unchanged page stable', async () => {
    const engine = new PlaywrightChromiumEngine();
    try {
      const page = await (await engine.createSession({ headless: true })).newPage();
      await page.navigate({
        url: 'data:text/html,<body><dialog open><button>Confirm</button></dialog></body>',
      });
      const first = await page.observe({});
      const second = await page.observe({});
      expect(second.revision).toBe(first.revision);
      expect(second.elements.map((e) => [e.ref, e.depth, e.block])).toEqual(
        first.elements.map((e) => [e.ref, e.depth, e.block])
      );
    } finally {
      await engine.close();
    }
  });
});
