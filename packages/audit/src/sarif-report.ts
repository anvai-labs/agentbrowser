/** T7 slice 4: SARIF 2.1.0 report adapter. Normalizes findings from the
 * audit adapters (accessibility, scanner-regression) into the SARIF 2.1.0
 * format — the standard interchange for security and quality findings.
 * Visual-regression verdicts are NOT security findings and are excluded
 * (they belong to the visual adapter's own baseline workflow). */

import type {
  ConfirmationEvidence,
  SarifReport,
  SarifResult,
  SarifRule,
} from '@agentbrowser/engagement';
import { confirmationProperties, encodeUri } from '@agentbrowser/engagement';
import type { AccessibilityAuditResult } from './accessibility-audit.js';
import type { RoleAccessResult } from './role-access-check.js';
import type { ScannerFinding, ScannerScanResult } from './scanner-regression.js';

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
  sourceUrl?: string
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

function scannerSarif(result: ScannerScanResult): { rules: SarifRule[]; results: SarifResult[] } {
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
      level: finding.status === 'confirmed' ? (RISK_TO_LEVEL[finding.risk] ?? 'warning') : 'none',
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
      ...confirmationProperties(
        finding.status,
        (finding as ScannerFinding & { evidence?: ConfirmationEvidence }).evidence,
        {
          risk: finding.risk,
          ...(finding.scannerConfidence !== undefined
            ? { scannerConfidence: finding.scannerConfidence }
            : {}),
        }
      ),
    };
  });
  return { rules: [...seen.values()], results: sarifResults };
}

function roleAccessSarif(result: RoleAccessResult): { rules: SarifRule[]; results: SarifResult[] } {
  const rules: SarifRule[] =
    result.findings.length === 0
      ? []
      : [
          {
            id: 'broken-access-control',
            name: 'Broken access control between identities',
            shortDescription: { text: 'An identity read a resource owned by another identity' },
            defaultConfiguration: { level: 'error' },
          },
        ];
  const results: SarifResult[] = result.findings.map((finding) => ({
    ruleId: finding.kind,
    level: 'error',
    message: { text: `identity ${finding.actor} read a resource owned by ${finding.owner}` },
    locations: [{ physicalLocation: { artifactLocation: { uri: encodeUri(finding.url) } } }],
    partialFingerprints: { ownerActorUrl: `${finding.owner}::${finding.actor}::${finding.url}` },
    ...confirmationProperties(finding.status, finding.evidence, {
      owner: finding.owner,
      actor: finding.actor,
    }),
  }));
  return { rules, results };
}

/** Build a SARIF 2.1.0 report from audit findings. Accepts any subset of
 * the finding adapters' results; absent adapters produce empty runs. */
export function buildSarifReport(inputs: {
  accessibility?: AccessibilityAuditResult;
  scanner?: ScannerScanResult;
  roleAccess?: RoleAccessResult;
  accessibilitySourceUrl?: string;
  toolName?: string;
  toolVersion?: string;
}): SarifReport {
  const toolName = inputs.toolName ?? 'agentbrowser-audit';
  const runs: SarifReport['runs'] = [];

  if (inputs.accessibility !== undefined) {
    const { rules, results } = accessibilitySarif(
      inputs.accessibility,
      inputs.accessibilitySourceUrl
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
    const { rules, results } = scannerSarif(inputs.scanner);
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

  if (inputs.roleAccess !== undefined) {
    const { rules, results } = roleAccessSarif(inputs.roleAccess);
    runs.push({
      tool: {
        driver: {
          name: `${toolName}-role-access`,
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
