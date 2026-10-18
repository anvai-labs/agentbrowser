import { verifyEngagementLedger } from '@agentbrowser/core';
import { type EngagementScopeOptions, EngagementScopePolicy } from '@agentbrowser/policy';
import { type ConfirmationEvidence, confirmFinding } from './finding-confirmation.js';
import {
  confirmationProperties,
  type SarifReport,
  type SarifResult,
  type SarifRule,
} from './sarif-report.js';

/**
 * T10 M3: findings bound to an engagement. A finding is checked against an exported,
 * chain-verified engagement ledger:
 *
 * | Rule | Refused when |
 * | --- | --- |
 * | in scope | the URL is outside the scope recorded in `engagement.opened` |
 * | evidence | a confirmed finding lacks independent-reproduction evidence |
 * | citations | a confirmed finding cites no ledger entry |
 * | each citation | the record is missing, not a request, blocked or failed, or its origin+path or method differs |
 *
 * The SARIF export is a draft for manual submission: nothing here sends a finding anywhere.
 */

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface EngagementFinding {
  id: string;
  title: string;
  severity: FindingSeverity;
  status: 'suspected' | 'confirmed';
  url: string;
  description: string;
  method?: string;
  ruleId?: string;
  /** Ledger record sequence numbers this finding cites. */
  ledgerRefs?: number[];
  evidence?: ConfirmationEvidence;
}

export interface FindingIssue {
  findingId: string;
  issue: string;
}

export type EngagementFindingsCheck =
  | {
      ok: true;
      engagementId: string;
      program?: Record<string, unknown>;
      closed: boolean;
      records: number;
      findings: EngagementFinding[];
      warnings: string[];
    }
  | { ok: false; issues: FindingIssue[] };

interface LedgerLine {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

const MAX_TEXT = 2_000;
const isString = (value: unknown, max = MAX_TEXT): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max;

/** origin + path, the form the ledger records (no query, no fragment). */
const originPath = (url: URL): string => `${url.origin}${url.pathname}`;

function parseFindings(input: unknown, issues: FindingIssue[]): EngagementFinding[] {
  if (!Array.isArray(input)) {
    issues.push({ findingId: '*', issue: 'findings must be a JSON array' });
    return [];
  }
  const seen = new Set<string>();
  const findings: EngagementFinding[] = [];
  for (const [index, raw] of input.entries()) {
    const item = raw as Record<string, unknown> | null;
    const id = typeof item?.id === 'string' ? item.id : `#${index}`;
    const bad = (issue: string): void => {
      issues.push({ findingId: id, issue });
    };
    if (item === null || typeof item !== 'object') {
      bad('a finding must be an object');
      continue;
    }
    if (!isString(item.id, 200)) {
      bad('id must be a non-empty string');
      continue;
    }
    if (seen.has(item.id)) {
      bad('duplicate finding id');
      continue;
    }
    seen.add(item.id);
    if (!isString(item.title, 200)) {
      bad('title must be a non-empty string');
      continue;
    }
    if (!isString(item.description)) {
      bad('description must be a non-empty string');
      continue;
    }
    if (!FINDING_SEVERITIES.includes(item.severity as FindingSeverity)) {
      bad(`severity must be one of ${FINDING_SEVERITIES.join(', ')}`);
      continue;
    }
    if (item.status !== 'suspected' && item.status !== 'confirmed') {
      bad('status must be suspected or confirmed');
      continue;
    }
    let url: URL;
    try {
      url = new URL(String(item.url));
    } catch {
      bad('url must be an absolute URL');
      continue;
    }
    if (url.username !== '' || url.password !== '') {
      bad('url must not carry credentials');
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      bad('url must be http(s)');
      continue;
    }
    if (item.method !== undefined && !isString(item.method, 16)) {
      bad('method must be a string');
      continue;
    }
    if (item.ruleId !== undefined && !isString(item.ruleId, 200)) {
      bad('ruleId must be a string');
      continue;
    }
    if (
      item.ledgerRefs !== undefined &&
      (!Array.isArray(item.ledgerRefs) ||
        !item.ledgerRefs.every((ref) => Number.isInteger(ref) && (ref as number) >= 0))
    ) {
      bad('ledgerRefs must be an array of record sequence numbers');
      continue;
    }
    // A copy: the check normalizes method and citations without touching the caller's objects.
    const copy = { ...item } as unknown as EngagementFinding;
    if (Array.isArray(item.ledgerRefs)) copy.ledgerRefs = [...(item.ledgerRefs as number[])];
    findings.push(copy);
  }
  return findings;
}

function parseLedger(text: string): LedgerLine[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LedgerLine);
}

export function checkEngagementFindings(
  ledgerText: string,
  input: unknown
): EngagementFindingsCheck {
  const verdict = verifyEngagementLedger(ledgerText);
  if (!verdict.ok)
    return {
      ok: false,
      issues: [
        {
          findingId: '*',
          issue: `the ledger chain is broken at seq ${verdict.seq}: ${verdict.reason}`,
        },
      ],
    };
  const lines = parseLedger(ledgerText);
  const opened = lines[0];
  const snapshot = opened?.data?.scope as Record<string, unknown> | undefined;
  const engagementId = opened?.data?.engagementId;
  if (
    opened?.type !== 'engagement.opened' ||
    snapshot === undefined ||
    typeof engagementId !== 'string' ||
    !Array.isArray(snapshot.allowedHosts) ||
    snapshot.allowedHosts.length === 0 ||
    !snapshot.allowedHosts.every((host) => typeof host === 'string')
  )
    return {
      ok: false,
      issues: [{ findingId: '*', issue: 'the ledger has no engagement.opened scope snapshot' }],
    };
  // The scope as recorded; time, budget and identity markers do not judge evidence.
  const scope = new EngagementScopePolicy(
    { checkRequest: async () => {} },
    {
      allowedHosts: snapshot.allowedHosts as string[],
      ...(Array.isArray(snapshot.pathRules) && snapshot.pathRules.length > 0
        ? { pathRules: snapshot.pathRules as NonNullable<EngagementScopeOptions['pathRules']> }
        : {}),
      ...(snapshot.allowedMethods !== undefined
        ? { allowedMethods: snapshot.allowedMethods as string[] }
        : {}),
      ...(snapshot.excludeHosts !== undefined
        ? { excludeHosts: snapshot.excludeHosts as string[] }
        : {}),
      ...(snapshot.excludePaths !== undefined
        ? {
            excludePaths: snapshot.excludePaths as NonNullable<
              EngagementScopeOptions['excludePaths']
            >,
          }
        : {}),
      ...(snapshot.allowedSchemes !== undefined
        ? { allowedSchemes: snapshot.allowedSchemes as string[] }
        : {}),
      ...(snapshot.allowedPorts !== undefined
        ? { allowedPorts: snapshot.allowedPorts as number[] }
        : {}),
    }
  );
  const bySeq = new Map(lines.map((line) => [line.seq, line]));
  const issues: FindingIssue[] = [];
  const findings = parseFindings(input, issues);
  for (const finding of findings) {
    const bad = (issue: string): void => {
      issues.push({ findingId: finding.id, issue });
    };
    const url = new URL(finding.url);
    finding.ledgerRefs = [...new Set(finding.ledgerRefs ?? [])];
    // With no method given, the cited requests decide it (they must agree); else GET.
    const citedMethods = new Set(
      finding.ledgerRefs
        .map((ref) => bySeq.get(ref))
        .filter((record) => record?.type === 'request' && typeof record.data.method === 'string')
        .map((record) => String(record?.data.method).toUpperCase())
    );
    if (finding.method === undefined && citedMethods.size > 1)
      bad(`the cited requests use different methods (${[...citedMethods].join(', ')}); set method`);
    const method = (finding.method ?? [...citedMethods][0] ?? 'GET').toUpperCase();
    finding.method = method;
    const verdictOf = scope.check({ url: finding.url, method });
    if (!verdictOf.allowed) bad(`the URL is outside the engagement scope (${verdictOf.scope})`);
    if (finding.status === 'confirmed') {
      try {
        confirmFinding({ status: 'suspected' }, finding.evidence as ConfirmationEvidence);
      } catch (error) {
        bad((error as Error).message);
      }
      if ((finding.ledgerRefs ?? []).length === 0)
        bad('a confirmed finding must cite at least one ledger request');
    }
    for (const ref of finding.ledgerRefs ?? []) {
      const record = bySeq.get(ref);
      if (record === undefined) {
        bad(`no ledger record ${ref}`);
        continue;
      }
      if (record.type !== 'request') {
        bad(`ledger record ${ref} is not a request`);
        continue;
      }
      if (record.data.blocked === true) {
        bad(
          `ledger record ${ref} was blocked (${String(record.data.scope ?? record.data.reason ?? 'denied')})`
        );
        continue;
      }
      if (record.data.outcome === 'failed') {
        bad(`ledger record ${ref} failed: it never reached the target`);
        continue;
      }
      if (record.data.url !== originPath(url))
        bad(
          `ledger record ${ref} (${String(record.data.url)}) does not match the finding URL ${originPath(url)}`
        );
      else if (String(record.data.method).toUpperCase() !== method)
        bad(`ledger record ${ref} method ${String(record.data.method)} does not match ${method}`);
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  const program = snapshot.program as Record<string, unknown> | undefined;
  return {
    ok: true,
    engagementId,
    ...(program !== undefined ? { program } : {}),
    closed: verdict.closed,
    records: verdict.records,
    findings,
    warnings: verdict.closed
      ? []
      : ['the ledger is not closed (truncated, or the engagement is still running)'],
  };
}

const LEVEL: Record<FindingSeverity, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
  informational: 'note',
};

/** A SARIF 2.1.0 draft of checked findings, for manual submission. */
export function buildEngagementSarif(
  check: Extract<EngagementFindingsCheck, { ok: true }>,
  toolVersion?: string
): SarifReport {
  const rules: SarifRule[] = [];
  const results: SarifResult[] = check.findings.map((finding) => {
    const ruleId = finding.ruleId ?? 'manual-finding';
    if (!rules.some((rule) => rule.id === ruleId)) rules.push({ id: ruleId, name: ruleId });
    const confirmed = finding.status === 'confirmed';
    return {
      ruleId,
      // SARIF 2.1.0 §3.27.10: a result that is not `fail` has level `none`; risk rides in properties.
      level: confirmed ? LEVEL[finding.severity] : 'none',
      message: { text: `${finding.title}: ${finding.description}` },
      // Origin + path only: a researcher's URL may carry query tokens; WHATWG serialization is
      // already a valid URI (IPv6 brackets kept).
      locations: [
        { physicalLocation: { artifactLocation: { uri: originPath(new URL(finding.url)) } } },
      ],
      partialFingerprints: { findingId: finding.id },
      ...confirmationProperties(finding.status, finding.evidence, {
        findingId: finding.id,
        risk: finding.severity,
        engagementId: check.engagementId,
        ...(check.program !== undefined ? { program: check.program } : {}),
        method: (finding.method ?? 'GET').toUpperCase(),
        ledgerRefs: [...(finding.ledgerRefs ?? [])],
      }),
    };
  });
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'agentbrowser-engagement',
            ...(toolVersion !== undefined ? { version: toolVersion } : {}),
            rules,
          },
        },
        results,
        properties: {
          draft: true,
          submission: 'manual',
          engagementId: check.engagementId,
          ...(check.program !== undefined ? { program: check.program } : {}),
          ledger: { records: check.records, closed: check.closed },
        },
      },
    ],
  };
}
