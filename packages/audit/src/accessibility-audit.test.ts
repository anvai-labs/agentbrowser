import { describe, expect, it } from 'vitest';
import {
  type AccessibilityBaseline,
  compareAccessibility,
  runAccessibilityAudit,
} from './accessibility-audit.js';

const DEFECTIVE = '<html><body><img src="x.png"><button></button><p>copy</p></body></html>';
// A clean control under the default ruleset: labeled image, named button,
// document title, lang attribute, landmarked content.
const CLEAN =
  '<html lang="en"><head><title>Accessible fixture</title></head><body><main>' +
  '<img src="x.png" alt="A fixture image"><button type="button">Do it</button>' +
  '<p>copy</p></main></body></html>';

function toBaseline(
  violations: Awaited<ReturnType<typeof runAccessibilityAudit>>['violations']
): AccessibilityBaseline {
  return {
    formatVersion: 1,
    violations: violations.map((violation) => ({
      ruleId: violation.ruleId,
      targets: violation.targets,
    })),
    capturedAt: '2026-10-03T00:00:00.000Z',
  };
}

describe('accessibility audit adapter (T7 slice 1b)', () => {
  it('gate 1: seeded defects fail — unlabeled image and empty button are found', async () => {
    const result = await runAccessibilityAudit(DEFECTIVE);
    expect(result.verdict).toBe('violations');
    const ruleIds = result.violations.map((violation) => violation.ruleId);
    expect(ruleIds).toContain('image-alt');
    expect(ruleIds).toContain('button-name');
    for (const violation of result.violations) {
      expect(violation.nodeCount).toBeGreaterThan(0);
      expect(violation.targets.length).toBeGreaterThan(0);
    }
  });

  it('gate 2: a clean, properly labeled control page passes', async () => {
    const result = await runAccessibilityAudit(CLEAN);
    // The control may still trip non-structural rules on a synthetic page
    // (e.g. region/landmark heuristics); the structural defects specifically
    // seeded in gate 1 must be gone.
    const ruleIds = result.violations.map((violation) => violation.ruleId);
    expect(ruleIds).not.toContain('image-alt');
    expect(ruleIds).not.toContain('button-name');
    expect(result.passesCount).toBeGreaterThan(0);
  });

  it('gate 3: baseline comparison — acknowledged set within baseline; extra defect regresses; fix resolves', async () => {
    const seeded = await runAccessibilityAudit(DEFECTIVE);
    // Same page against its own acknowledged violations: within-baseline.
    const same = compareAccessibility(seeded, toBaseline(seeded.violations));
    expect(same.verdict).toBe('within-baseline');
    expect(same.newViolations).toEqual([]);

    // An EXTRA defect on top of the acknowledged set regresses.
    const worse = await runAccessibilityAudit(
      `${DEFECTIVE}<input type="text" id="extra" aria-labelledby="missing-id">`
    );
    const worseComparison = compareAccessibility(worse, toBaseline(seeded.violations));
    expect(worseComparison.verdict).toBe('regression');
    expect(worseComparison.newViolations.length).toBeGreaterThan(0);

    // Fixing a violation the baseline acknowledged resolves it.
    const fixed = await runAccessibilityAudit(
      '<html><body><img src="x.png" alt="described"><button>Named</button><p>copy</p></body></html>'
    );
    const fixedComparison = compareAccessibility(fixed, toBaseline(seeded.violations));
    expect(fixedComparison.resolved).toContain('image-alt');
    expect(fixedComparison.resolved).toContain('button-name');
  });

  it('gate 4: page scripts are never executed — a DOM-destroying payload stays inert', async () => {
    // The inline payload would REMOVE the image (killing the image-alt
    // finding) if the page's scripts executed. Its survival in the output
    // is the public-API proof of inertness.
    const hostile =
      '<html><body><img src="x.png"><button></button>' +
      '<script>document.querySelector("img").remove();</script></body></html>';
    const result = await runAccessibilityAudit(hostile);
    expect(result.verdict).toBe('violations');
    expect(result.violations.map((violation) => violation.ruleId)).toContain('image-alt');
  });

  it('gate 5: rule tags scope the run — WCAG 2 A-level defects found, best-practice rules excluded', async () => {
    const result = await runAccessibilityAudit(DEFECTIVE, {
      tags: ['wcag2a'],
    });
    const ruleIds = result.violations.map((violation) => violation.ruleId);
    // Both seeded defects are WCAG 2 A-level failures.
    expect(ruleIds).toContain('image-alt');
    expect(ruleIds).toContain('button-name');
    // The best-practice 'region' rule is outside the requested tag family.
    expect(ruleIds).not.toContain('region');
  });

  it('gate 6: the layout-dependent boundary is pinned — color-contrast is incomplete, never passing', async () => {
    const result = await runAccessibilityAudit(DEFECTIVE);
    // color-contrast requires real rendering; in this lane axe reports it
    // INCOMPLETE — it must never appear as a pass or a violation here.
    const ruleIds = result.violations.map((violation) => violation.ruleId);
    expect(ruleIds).not.toContain('color-contrast');
    expect(result.incompleteRules).toContain('color-contrast');
  });

  it('gate 7: comparison against an empty baseline reports every violation as new', async () => {
    const seeded = await runAccessibilityAudit(DEFECTIVE);
    const comparison = compareAccessibility(seeded, toBaseline([]));
    expect(comparison.verdict).toBe('regression');
    expect(comparison.newViolations.length).toBe(seeded.violations.length);
    expect(comparison.resolved).toEqual([]);
  });
});
