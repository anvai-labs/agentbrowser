import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';

/** T7 slice 1b: accessibility audit adapter over the captured-HTML lane.
 * Wraps axe-core in a Node DOM (jsdom) — NO page-context injection exists
 * in the engine (ADR-009 posture), and page scripts are NEVER executed
 * here: only the bundled axe source is evaluated in the window. The lane
 * boundary is recorded, not hidden: rules that require real layout
 * (color-contrast and friends) cannot run against a Node DOM and surface
 * as incomplete instead of passing silently. */

export interface AccessibilityViolation {
  ruleId: string;
  impact: string | null;
  help: string;
  /** Page-derived selectors — hostile data; treat as untrusted. */
  targets: string[][];
  nodeCount: number;
}

export interface AccessibilityAuditResult {
  verdict: 'clean' | 'violations';
  violations: AccessibilityViolation[];
  /** Rules axe could not complete in this lane (layout-dependent). */
  incompleteRules: string[];
  passesCount: number;
}

export interface AccessibilityBaseline {
  formatVersion: 1;
  /** The violation set acknowledged at baseline time. */
  violations: Array<{ ruleId: string; targets: string[][] }>;
  capturedAt: string;
}

export interface AccessibilityComparison {
  /** 'clean': no violations at all. 'within-baseline': violations exist
   * but all were acknowledged. 'regression': at least one NEW violation. */
  verdict: 'clean' | 'within-baseline' | 'regression';
  newViolations: AccessibilityViolation[];
  /** RuleIds acknowledged at baseline that no longer violate. */
  resolved: string[];
}

const require = createRequire(import.meta.url);

let axeSource: string | undefined;
function axeSourceOf(): string {
  axeSource ??= readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  return axeSource;
}

const HOSTILE_CAP = 256;

function normalizeViolations(results: {
  violations: Array<{
    id: string;
    impact: string | null;
    help: string;
    nodes: Array<{ target: string[][] }>;
  }>;
  incomplete: Array<{ id: string }>;
  passes: unknown[];
}): AccessibilityAuditResult {
  const violations = results.violations.map((violation) => ({
    ruleId: violation.id,
    impact: violation.impact,
    help: violation.help.slice(0, HOSTILE_CAP),
    targets: violation.nodes
      .slice(0, HOSTILE_CAP)
      .map((node) =>
        node.target
          .slice(0, HOSTILE_CAP)
          .flatMap((segment) =>
            (Array.isArray(segment) ? segment : [segment]).map((part) =>
              String(part).slice(0, HOSTILE_CAP)
            )
          )
      ),
    nodeCount: violation.nodes.length,
  }));
  return {
    verdict: violations.length === 0 ? 'clean' : 'violations',
    violations,
    incompleteRules: results.incomplete.map((rule) => rule.id),
    passesCount: results.passes.length,
  };
}

/** Run axe-core against captured page HTML in a Node DOM. Page scripts are
 * never executed; the results are page-derived data (hostile until
 * treated). */
export async function runAccessibilityAudit(
  html: string,
  options?: { url?: string; tags?: string[] }
): Promise<AccessibilityAuditResult> {
  // The virtual console drops jsdom's "Not implemented" notices (canvas
  // probing by some rules) — noise, not findings. Any other jsdom error
  // (uncaught exception in evaluated code, realm rejections beyond the
  // awaited run promise) surfaces rather than vanishing.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    if (!String(error).includes('Not implemented')) throw error;
  });
  const dom = new JSDOM(html, {
    url: options?.url ?? 'https://audited.page/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  dom.window.eval(axeSourceOf());
  const runOptions = options?.tags
    ? {
        runOnly: { type: 'tags' as const, values: options.tags },
        resultTypes: ['violations' as const],
      }
    : { resultTypes: ['violations' as const] };
  try {
    const results = (await dom.window.eval(
      `axe.run(document, ${JSON.stringify(runOptions)})`
    )) as Parameters<typeof normalizeViolations>[0] & { passes: unknown[] };
    return normalizeViolations(results);
  } finally {
    dom.window.close();
  }
}

const violationKey = (ruleId: string, targets: string[][]): string =>
  `${ruleId}::${JSON.stringify(targets)}`;

/** Compare an audit result against the acknowledged baseline: NEW
 * violations are regressions; acknowledged ones that disappeared are
 * reported as resolved. */
export function compareAccessibility(
  result: AccessibilityAuditResult,
  baseline: AccessibilityBaseline
): AccessibilityComparison {
  const acknowledged = new Set(
    baseline.violations.map((violation) => violationKey(violation.ruleId, violation.targets))
  );
  const baselineRuleIds = new Set(baseline.violations.map((violation) => violation.ruleId));
  const newViolations = result.violations.filter(
    (violation) => !acknowledged.has(violationKey(violation.ruleId, violation.targets))
  );
  const currentRuleIds = new Set(result.violations.map((violation) => violation.ruleId));
  const resolved = [...baselineRuleIds].filter((ruleId) => !currentRuleIds.has(ruleId));
  const verdict: AccessibilityComparison['verdict'] =
    result.violations.length === 0
      ? 'clean'
      : newViolations.length > 0
        ? 'regression'
        : 'within-baseline';
  return { verdict, newViolations, resolved };
}
