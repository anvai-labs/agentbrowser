/** T7 slice 4: SARIF 2.1.0 report adapter. Normalizes findings from the
 * audit adapters (accessibility, scanner-regression) into the SARIF 2.1.0
 * format — the standard interchange for security and quality findings.
 * Visual-regression verdicts are NOT security findings and are excluded
 * (they belong to the visual adapter's own baseline workflow). */

export interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri: string };
    };
  }>;
  partialFingerprints?: Record<string, string>;
}

export interface SarifRule {
  id: string;
  name?: string;
  shortDescription?: { text: string };
  defaultConfiguration?: { level: string };
}

export interface SarifReport {
  $schema: string;
  version: '2.1.0';
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version?: string;
        informationUri?: string;
        rules: SarifRule[];
      };
    };
    results: SarifResult[];
  }>;
}

import type { AccessibilityAuditResult } from './accessibility-audit.js';
import type { ScannerScanResult } from './scanner-regression.js';

/** RFC 3986 percent-encode a URI reference so SARIF consumers and strict
 * validators accept it (raw < > " etc. are not valid URI characters). */
function encodeUri(uri: string): string {
  try {
    // encodeURI preserves the URI structure (scheme, host, path separators)
    // while percent-encoding invalid characters like < > " and spaces.
    return encodeURI(uri).replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  } catch {
    return uri;
  }
}

const IMPACT_TO_LEVEL: Record<string, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  serious: 'error',
  moderate: 'warning',
  minor: 'note',
  null: 'warning',
};

const RISK_TO_LEVEL: Record<string, 'error' | 'warning' | 'note'> = {
  high: 'error',
  medium: 'warning',
  low: 'note',
  informational: 'note',
};

function accessibilitySarif(
  result: AccessibilityAuditResult,
  sourceUrl?: string,
  toolVersion?: string
): { rules: SarifRule[]; results: SarifResult[] } {
  // Deduplicate rules by id (axe groups by rule, but a merged result
  // could carry duplicates — SARIF requires unique rule ids per run).
  const seenRules = new Map<string, SarifRule>();
  const rules: SarifRule[] = [];
  for (const violation of result.violations) {
    if (seenRules.has(violation.ruleId)) continue;
    seenRules.set(violation.ruleId, {
      id: violation.ruleId,
      name: violation.ruleId,
      shortDescription: { text: violation.help },
      defaultConfiguration: {
        level: IMPACT_TO_LEVEL[violation.impact ?? 'null'] ?? 'warning',
      },
    });
    rules.push(seenRules.get(violation.ruleId) as SarifRule);
  }
  const sarifResults: SarifResult[] = result.violations.map((violation) => ({
    ruleId: violation.ruleId,
    level: IMPACT_TO_LEVEL[violation.impact ?? 'null'] ?? 'warning',
    message: { text: violation.help },
    ...(sourceUrl
      ? {
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: encodeUri(sourceUrl) },
              },
            },
          ],
        }
      : {}),
    partialFingerprints: {
      // Per-finding fingerprint: ruleId + normalized targets (page-derived).
      accessibilityFinding: `${violation.ruleId}::${JSON.stringify(violation.targets)}`,
    },
  }));
  return { rules, results: sarifResults };
}

function scannerSarif(
  result: ScannerScanResult,
  toolVersion?: string
): { rules: SarifRule[]; results: SarifResult[] } {
  const seen = new Map<number, SarifRule>();
  const sarifResults: SarifResult[] = result.findings.map((finding) => {
    if (!seen.has(finding.pluginId)) {
      seen.set(finding.pluginId, {
        id: String(finding.pluginId),
        name: finding.name,
        shortDescription: { text: finding.name },
        defaultConfiguration: {
          level: RISK_TO_LEVEL[finding.risk] ?? 'warning',
        },
      });
    }
    return {
      ruleId: String(finding.pluginId),
      level: RISK_TO_LEVEL[finding.risk] ?? 'warning',
      message: { text: finding.name },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: encodeUri(finding.url) },
          },
        },
      ],
      partialFingerprints: {
        pluginIdUrl: `${finding.pluginId}::${finding.url}::${finding.parameter ?? ''}`,
      },
    };
  });
  return { rules: [...seen.values()], results: sarifResults };
}

/** Build a SARIF 2.1.0 report from audit findings. Accepts any subset of
 * the finding adapters' results; absent adapters produce empty runs. */
export function buildSarifReport(inputs: {
  accessibility?: AccessibilityAuditResult;
  scanner?: ScannerScanResult;
  accessibilitySourceUrl?: string;
  toolName?: string;
  toolVersion?: string;
}): SarifReport {
  const toolName = inputs.toolName ?? 'agentbrowser-audit';
  const runs: SarifReport['runs'] = [];

  if (inputs.accessibility !== undefined) {
    const { rules, results } = accessibilitySarif(
      inputs.accessibility,
      inputs.accessibilitySourceUrl,
      inputs.toolVersion
    );
    runs.push({
      tool: {
        driver: {
          name: `${toolName}-accessibility`,
          ...(inputs.toolVersion !== undefined ? { version: inputs.toolVersion } : {}),
          rules,
        },
      },
      results,
    });
  }
  if (inputs.scanner !== undefined) {
    const { rules, results } = scannerSarif(inputs.scanner, inputs.toolVersion);
    runs.push({
      tool: {
        driver: {
          name: `${toolName}-scanner`,
          ...(inputs.toolVersion !== undefined ? { version: inputs.toolVersion } : {}),
          rules,
        },
      },
      results,
    });
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs,
  };
}
