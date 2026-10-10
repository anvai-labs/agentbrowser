/**
 * G1 formControls context derivation (docs/agent-handoffs/
 * AGENTBROWSER_UI_GAPS_2026-10-10.md; ADR-021 addendum).
 *
 * The two exported page functions run INSIDE the browser via
 * locator.evaluateAll, which serializes the FUNCTION SOURCE — so every
 * helper they need is declared inside their bodies (no imports, no module
 * closures). They are also pure over the structural G1Element shape, which
 * makes the naming rules unit-testable without Chromium
 * (form-control-context-rules.test.ts) — the property an inline
 * evaluateAll callback cannot have (adversarial review round-3/F8).
 */

/** Structural browser-node shape the rules operate on. */
export interface G1Element {
  tagName: string;
  textContent: string | null;
  id: string;
  offsetWidth: number;
  offsetHeight: number;
  getAttribute(name: string): string | null;
  contains(other: unknown): boolean;
  ownerDocument: { getElementById(id: string): G1Element | null };
  closest(selector: string): G1Element | null;
  querySelectorAll(selector: string): G1Element[];
  previousElementSibling: G1Element | null;
  parentElement: G1Element | null;
}

export interface G1Described {
  index: number;
  tag: string;
  name?: string;
  context?: string;
  id?: string;
  automationId?: string;
  visible: boolean;
}

/**
 * Pass one: collect control names from one scan root. The caller merges
 * names across ALL roots (page-wide duplication, round-3/F6) before pass
 * two. Self-contained for evaluateAll serialization.
 */
export function g1CollectNamesPageFunction(nodes: G1Element[]): string[] {
  const names: string[] = [];
  for (const node of nodes) {
    const text = node.textContent?.trim().slice(0, 200) || undefined;
    const automationId = node.getAttribute('data-automation-id')?.trim() || undefined;
    const name =
      node.getAttribute('aria-label')?.trim() ||
      text ||
      automationId ||
      node.id.trim() ||
      undefined;
    if (name !== undefined) names.push(name);
  }
  return names;
}

/**
 * Pass two: derive described entries (name, context, ids, visibility) for
 * one scan root, using page-wide name counts from pass one. Self-contained
 * for evaluateAll serialization; unit-testable with structural mocks.
 */
export interface G1DescribeArgs {
  pageWideNameCounts: Record<string, number>;
  /** THIS root's contribution to pageWideNameCounts in pass one — pass two
   * REPLACES it with a recount, rather than adding (which double-counted). */
  ownRootPassOneCounts?: Record<string, number>;
  /** Mint cap from the host's MAX_FORM_CONTROLS — one source of truth. */
  cap: number;
}

export function g1DescribePageFunction(nodes: G1Element[], args: G1DescribeArgs): G1Described[] {
  const SECTIONING = 'section, article, fieldset, main';
  const ROW_SELECTOR = 'li, tr, [role="row"]';
  const LABEL_SELECTOR = 'strong, label, th';
  const HEADING_SELECTOR = 'h1, h2, h3, h4';
  const INTERACTIVE_HOST = 'button, [aria-haspopup], [role="button"], a[href]';

  type El = G1Element;

  // Round-6/F7: code-point clamp — a UTF-16 slice can split a surrogate
  // pair at the 120 boundary (same class as round-4/F8).
  const norm = (s: string | null | undefined): string | undefined => {
    const collapsed = s?.replace(/\s+/g, ' ').trim();
    if (!collapsed) return undefined;
    return Array.from(collapsed).slice(0, 120).join('') || undefined;
  };

  const basicName = (node: El): string | undefined => {
    const text = node.textContent?.trim().slice(0, 200) || undefined;
    const automationId = node.getAttribute('data-automation-id')?.trim() || undefined;
    return (
      node.getAttribute('aria-label')?.trim() || text || automationId || node.id.trim() || undefined
    );
  };

  const rowLabelOf = (node: El, ownName: string | undefined): string | undefined => {
    // All name-equality guards compare NORMALIZED forms: the own name may
    // carry different whitespace or exceed the 120-char label budget
    // (round-4/F2).
    const own = norm(ownName);
    // Structural row labels come FIRST (round-4/F6): Primer widgets chain
    // labelledby="value-id section-heading-id"; adopting the section
    // heading as the row label produced contexts like "X — X" while
    // bypassing the real row <strong>. labelledby sources outside the row
    // are a fallback only.
    let labelledByFallback: string | undefined;
    const labelledBy = node.getAttribute('aria-labelledby');
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const source = node.ownerDocument.getElementById(id);
        if (!source || node.contains(source)) continue;
        const label = norm(source.textContent);
        // A labelledby source repeating the generic name is not a row
        // label (round-2/F1). Round-7/F7: aria-labelledby sources are
        // ORDERED — the first valid source is primary; later ids must not
        // overwrite it.
        if (label && label !== own) {
          labelledByFallback = labelledByFallback ?? label;
          break;
        }
      }
    }
    // dl groups are dt/dd-scoped: a dd takes its preceding dt; multi-dd
    // groups have no row label — never scan the whole dl (round-2/F5).
    const dd = node.closest('dd');
    if (dd) {
      const dt = dd.previousElementSibling;
      if (dt?.tagName === 'DT') {
        const label = norm(dt.textContent);
        if (label && label !== own) return label;
      }
      return labelledByFallback;
    }
    const row = node.closest(ROW_SELECTOR);
    if (!row) return labelledByFallback;
    // Round-7/F5: a row may hold SEVERAL labeled controls (table rows with
    // multiple th/td widget pairs). The nearest label candidate PRECEDING
    // the control in document order is that control's label — returning
    // the first candidate labeled every control in the row identically.
    const candidates = row.querySelectorAll(LABEL_SELECTOR);
    const everything = row.querySelectorAll('*');
    const indexOf = (target: El): number => {
      for (let i = 0; i < everything.length; i += 1) {
        const el = everything[i] as El;
        if (el === target || el.contains(target)) return i;
      }
      return everything.length;
    };
    const ownPosition = indexOf(node);
    let nearest: { label: string; position: number; following: boolean } | undefined;
    for (const candidate of candidates) {
      // Exclude the control's own subtree AND candidates that CONTAIN the
      // control (round-1/F2 + round-5/F3): a wrapping <label> concatenates
      // the control's own generic text into its textContent.
      if (node.contains(candidate) || candidate.contains(node)) continue;
      // …and subtrees of SIBLING interactives in the same row: their
      // inner labels belong to those controls, not this row (round-3/F2).
      const host = candidate.closest(INTERACTIVE_HOST);
      if (host !== null && host !== node && row.contains(host)) continue;
      const label = norm(candidate.textContent);
      // A label equal to the control's own generic name is not a
      // disambiguator (round-3/F1).
      if (!label || label === own) continue;
      const position = indexOf(candidate);
      // Prefer the nearest PRECEDING candidate (table th/td pairs label
      // their control); a following candidate is accepted only when no
      // preceding one exists (labels rendered after the widget).
      if (nearest === undefined) {
        nearest = { label, position, following: position > ownPosition };
      } else if (position <= ownPosition && !nearest.following) {
        if (position > nearest.position) nearest = { label, position, following: false };
      } else if (position > ownPosition && nearest.following && position < nearest.position) {
        nearest = { label, position, following: true };
      }
    }
    return nearest?.label ?? labelledByFallback;
  };

  // Scope-bounded reverse heading walk (round-1/F3 + round-2/F2 +
  // round-3/F4): within the row's nearest sectioning ancestor, walk
  // backwards over siblings and their subtrees accepting only same-scope
  // headings; then climb outward. The boundary check runs BEFORE scanning
  // siblings so the walk never escapes the scope into page-wide work; the
  // walk is intentionally NOT memoized per scope because the result depends
  // on the row's position within the scope (sibling headings between rows).
  // Round-5/F4: the walk is bounded — a dashboard main with thousands of
  // preceding siblings must not block the page thread for every control.
  const SIBLING_VISIT_BUDGET = 60;
  const headingFor = (row: El): string | undefined => {
    let scope: El | null = row.closest(SECTIONING);
    while (scope) {
      let found: string | undefined;
      let cursor: El | null = row;
      let visits = 0;
      while (cursor !== null) {
        if (cursor === scope) break;
        if (visits >= SIBLING_VISIT_BUDGET) return undefined;
        visits += 1;
        const sibling: El | null = cursor.previousElementSibling;
        if (sibling !== null) {
          if (/^H[1-4]$/.test(sibling.tagName)) {
            if (sibling.closest(SECTIONING) === scope) {
              found = norm(sibling.textContent);
              if (found) break;
            }
          } else {
            const nested = sibling.querySelectorAll(HEADING_SELECTOR);
            for (let i = nested.length - 1; i >= 0; i -= 1) {
              const heading = nested[i] as El;
              if (heading.closest(SECTIONING) === scope) {
                found = norm(heading.textContent);
                if (found) break;
              }
            }
            if (found) break;
          }
          cursor = sibling;
        } else {
          cursor = cursor.parentElement;
        }
      }
      if (found !== undefined) return found;
      scope = scope.parentElement ? scope.parentElement.closest(SECTIONING) : null;
    }
    return undefined;
  };

  // Round-5/F4: derive only the nodes the host will keep (mint cap) —
  // the page-side derivation cost is bounded by the advertised budget.
  const { pageWideNameCounts, cap } = args;
  // Round-7/F9: the DOM may have changed between pass one and this pass.
  // Recompute THIS root's names now and merge over the pass-one counts, so
  // needsContext reflects the current DOM for this root while still seeing
  // other roots' names from pass one (best-effort cross-frame consistency;
  // a frame racing between passes is bounded by the frameCoverage
  // disclosure).
  const currentCounts: Record<string, number> = { ...pageWideNameCounts };
  for (const [name, count] of Object.entries(args.ownRootPassOneCounts ?? {})) {
    currentCounts[name] = (currentCounts[name] ?? 0) - count;
    if ((currentCounts[name] ?? 0) <= 0) delete currentCounts[name];
  }
  for (const node of nodes) {
    const name = basicName(node);
    if (name !== undefined) currentCounts[name] = (currentCounts[name] ?? 0) + 1;
  }
  return nodes.slice(0, cap).map((node, index) => {
    const automationId = node.getAttribute('data-automation-id')?.trim() || undefined;
    const name = basicName(node);
    const described: G1Described = {
      index,
      tag: node.tagName.toLowerCase(),
      ...(name !== undefined ? { name } : {}),
      ...(node.id !== '' ? { id: node.id } : {}),
      ...(automationId !== undefined ? { automationId } : {}),
      visible: node.offsetWidth > 0 || node.offsetHeight > 0,
    };
    // Context only where it earns its bytes: absent or page-wide
    // duplicated names (round-1/F6 + round-3/F6). The live-DOM handle is
    // never returned (round-2/F3).
    const needsContext = name === undefined || (currentCounts[name] ?? 0) >= 2;
    if (!needsContext) return described;
    const rowLabel = rowLabelOf(node, name);
    if (rowLabel === undefined) return described;
    const heading = headingFor(node);
    // Round-5/F2: when the fallback label came from a section heading, the
    // walk finds the SAME heading — compose only a real disambiguator.
    if (heading === undefined || heading === rowLabel) {
      return { ...described, context: rowLabel };
    }
    return { ...described, context: `${rowLabel} — ${heading}` };
  });
}
