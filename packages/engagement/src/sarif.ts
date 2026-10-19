import type { ConfirmationEvidence } from './finding-confirmation.js';

/** Light SARIF 2.1.0 primitives shared by the audit adapters and the engagement findings
 * exporter. No DOM or image dependencies. */

export interface SarifResult {
  ruleId: string;
  /** SARIF 2.1.0 §3.27.10: a result whose kind is not `fail` SHALL have level `none`, so a
   * suspected finding is `none` and carries its risk in `properties.risk`. */
  level: 'error' | 'warning' | 'note' | 'none';
  /** SARIF 2.1.0 result kind. T7: a suspected finding is `review` (needs a human), a confirmed
   * one is `fail`. Absent for adapters without a confirmation concept (accessibility). */
  kind?: 'fail' | 'review';
  message: { text: string };
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri: string };
    };
  }>;
  partialFingerprints?: Record<string, string>;
  properties?: Record<string, unknown>;
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
    properties?: Record<string, unknown>;
  }>;
}

/** The confirmation labelling every security result carries (T7). Evidence appears only on a
 * confirmed result; the private payload never does (the evidence holds a description). */
export function confirmationProperties(
  status: 'suspected' | 'confirmed',
  evidence: ConfirmationEvidence | undefined,
  extra: Record<string, unknown> = {}
): Pick<SarifResult, 'kind' | 'properties'> {
  return {
    kind: status === 'confirmed' ? 'fail' : 'review',
    properties: {
      status,
      ...extra,
      ...(status === 'confirmed' && evidence !== undefined
        ? {
            evidence: {
              method: evidence.method,
              reproducedAt: evidence.reproducedAt,
              observation: evidence.observation,
              cleanup: { ...evidence.cleanup },
            },
          }
        : {}),
    },
  };
}

/** RFC 3986 percent-encode a URI reference so SARIF consumers and strict
 * validators accept it (raw < > " etc. are not valid URI characters). */
export function encodeUri(uri: string): string {
  try {
    // encodeURI preserves the URI structure (scheme, host, path separators)
    // while percent-encoding invalid characters like < > " and spaces.
    return encodeURI(uri).replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  } catch {
    return uri;
  }
}
