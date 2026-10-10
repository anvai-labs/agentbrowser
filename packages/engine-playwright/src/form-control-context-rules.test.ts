import { describe, expect, it } from 'vitest';
import {
  type G1Element,
  g1CollectNamesPageFunction,
  g1DescribePageFunction,
} from './form-control-context.js';

/**
 * Unit tests for the G1 naming rules — the review round-3/F8 payoff: the
 * derivation is a pure function over structural elements, so every rule
 * (own-name skips, sibling-interactive exclusion, scope-bounded headings,
 * budget gating) is testable without Chromium. The Chromium-level contract
 * lives in form-control-context.test.ts.
 */

interface NodeSpec {
  tag: string;
  text?: string;
  id?: string;
  ariaLabel?: string;
  labelledBy?: string;
  children?: NodeSpec[];
}

/** Concatenated descendant text, matching the real DOM's textContent
 * semantics (round-5/F8): ancestor text INCLUDES child text, so a mock that
 * returns null for parents hides exactly the wrapping-label bug class. */
function descendantText(spec: NodeSpec): string {
  const own = spec.text ?? '';
  const childText = (spec.children ?? []).map((child) => descendantText(child)).join('');
  return (own + childText).trim();
}

/** Build a structural G1Element tree from a spec (parent/child/sibling links). */
function tree(spec: NodeSpec, parent: G1Element | null = null): G1Element {
  const children: G1Element[] = (spec.children ?? []).map((child) => tree(child));
  const self: G1Element = {
    tagName: spec.tag.toUpperCase(),
    textContent: descendantText(spec),
    id: spec.id ?? '',
    offsetWidth: 10,
    offsetHeight: 10,
    getAttribute: (name: string) =>
      name === 'aria-label'
        ? (spec.ariaLabel ?? null)
        : name === 'aria-labelledby'
          ? (spec.labelledBy ?? null)
          : null,
    contains: (other: unknown): boolean => {
      let node = other as G1Element | null;
      while (node) {
        if (node === self) return true;
        node = node.parentElement;
      }
      return false;
    },
    ownerDocument: { getElementById: () => null },
    closest: (): G1Element | null => null,
    querySelectorAll: (): G1Element[] => [],
    previousElementSibling: null,
    parentElement: parent,
  };
  // Link children lazily via a mutable parent map: simplest correct approach
  // is rebuilding with the parent reference after creation.
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i] as G1Element & { parentElement: G1Element | null };
    child.parentElement = self;
    child.previousElementSibling = i > 0 ? (children[i - 1] as G1Element) : null;
    (self as unknown as { children: G1Element[] }).children = children;
  }
  return self;
}

function controlInRow(rowLabel: string, name: string): G1Element {
  const row = tree({
    tag: 'li',
    children: [
      { tag: 'strong', text: rowLabel },
      { tag: 'span', text: name },
    ],
  });
  const strong = (row as unknown as { children: G1Element[] }).children[0] as G1Element;
  const control = (row as unknown as { children: G1Element[] }).children[1] as G1Element;
  // Wire closest/querySelectorAll for the control.
  (
    control as G1Element & {
      closest: (selector: string) => G1Element | null;
      querySelectorAll: (selector: string) => G1Element[];
    }
  ).closest = (selector: string) => (selector.includes('li') ? row : null);
  (
    row as G1Element & {
      querySelectorAll: (selector: string) => G1Element[];
    }
  ).querySelectorAll = (selector: string) => (selector.includes('strong') ? [strong] : []);
  void control.closest('li');
  return control;
}

describe('g1 page-function naming rules (unit)', () => {
  it('derives context for duplicated names from the row label', () => {
    const a = controlInRow('Contents', 'Access: No access');
    const b = controlInRow('Pull requests', 'Access: No access');
    const described = g1DescribePageFunction([a, b], { 'Access: No access': 2 });
    expect(described[0]?.context).toBe('Contents');
    expect(described[1]?.context).toBe('Pull requests');
  });

  it('skips context for page-wide unique names even in labeled rows', () => {
    const a = controlInRow('Contents', 'Access: No access');
    const unique = controlInRow('Solo', 'A unique menu');
    const described = g1DescribePageFunction([a, unique], {
      'Access: No access': 1,
      'A unique menu': 1,
    });
    expect(described[0]?.context).toBeUndefined();
    expect(described[1]?.context).toBeUndefined();
  });

  it('never returns a context equal to the control own name', () => {
    const row = tree({
      tag: 'li',
      children: [
        { tag: 'strong', text: 'Access: No access' },
        { tag: 'span', text: 'Access: No access' },
      ],
    });
    const strong = (row as unknown as { children: G1Element[] }).children[0] as G1Element;
    const control = (row as unknown as { children: G1Element[] }).children[1] as G1Element;
    (control as G1Element & { closest: (s: string) => G1Element | null }).closest = (s: string) =>
      s.includes('li') ? row : null;
    (row as G1Element & { querySelectorAll: (s: string) => G1Element[] }).querySelectorAll = (
      s: string
    ) => (s.includes('strong') ? [strong] : []);
    const described = g1DescribePageFunction([control], { 'Access: No access': 2 });
    expect(described[0]?.context).toBeUndefined();
  });

  it('excludes labels inside sibling interactives of the same row', () => {
    const row = tree({
      tag: 'li',
      children: [
        { tag: 'div', ariaLabel: undefined, children: [{ tag: 'strong', text: 'Add' }] },
        { tag: 'span', text: 'Access: No access' },
      ],
    });
    const kids = (row as unknown as { children: G1Element[] }).children;
    const strong = (kids[0] as unknown as { children: G1Element[] }).children[0] as G1Element;
    const control = kids[1] as G1Element;
    // The sibling div is interactive (aria-haspopup host): strong inside it
    // must not become this control's label.
    (control as G1Element & { closest: (s: string) => G1Element | null }).closest = (s: string) =>
      s.includes('li') ? row : null;
    (row as G1Element & { querySelectorAll: (s: string) => G1Element[] }).querySelectorAll = (
      s: string
    ) => (s.includes('strong') ? [strong] : []);
    (strong as G1Element & { closest: (s: string) => G1Element | null }).closest = (s: string) => {
      if (s.includes('button') || s.includes('aria-haspopup')) return kids[0] as G1Element;
      return null;
    };
    const described = g1DescribePageFunction([control], { 'Access: No access': 2 });
    expect(described[0]?.context).toBeUndefined();
  });
});

describe('pass-one/pass-two name parity (round-4/F4)', () => {
  it('collect names match the names the describe pass mints, for every fixture control', () => {
    const fixtures = [
      controlInRow('Contents', 'Access: No access'),
      controlInRow('Pull requests', 'Access: No access'),
      controlInRow('Solo', 'A unique menu'),
    ];
    const counts: Record<string, number> = {};
    for (const name of g1CollectNamesPageFunction(fixtures)) {
      counts[name] = (counts[name] ?? 0) + 1;
    }
    // If these two derivations ever drift (a name source edited in one
    // pass only), needsContext evaluates against stale counts and context
    // silently mis-gates — this pin fails first.
    for (const described of g1DescribePageFunction(fixtures, counts)) {
      expect(counts[described.name as string]).toBeGreaterThan(0);
    }
    expect(g1CollectNamesPageFunction(fixtures)).toEqual(
      g1DescribePageFunction(fixtures, {}).map((d) => d.name)
    );
  });
});
