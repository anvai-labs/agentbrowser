import { VisualAuditError } from './visual-audit.js';

/** T7 slice 3: scanner-regression adapter. A bounded client over OWASP
 * ZAP's JSON API — the adapter drives an installed/launched scanner and
 * normalizes alerts into scoped findings; it BUILDS NO scanner. Scope
 * enforcement at the adapter boundary: the scanner cannot widen the
 * engagement (targets outside the allowed hosts are refused; alerts
 * against them are dropped and counted). The scanner probes targets at
 * the HTTP layer OUTSIDE agentbrowser's browser choke point — scanner
 * coverage is not browser containment, and this adapter must never be
 * described as such. */

export interface ScannerFinding {
  pluginId: number;
  url: string;
  parameter: string | null;
  risk: 'informational' | 'low' | 'medium' | 'high';
  name: string;
}

export interface ScannerScanResult {
  scannerVersion: string;
  scanId: number;
  findings: ScannerFinding[];
  /** Alerts against out-of-scope hosts, dropped and counted. */
  droppedOutOfScope: number;
}

export interface ZapClientOptions {
  baseUrl: string;
  /** Delegated ZAP API key, when the scanner requires one. */
  apiKey?: string;
  /** The engagement boundary (same shape as the slice-2a scope policy). */
  allowedHosts: string[];
  /** Total wall-clock budget for start+poll (default 120000). */
  pollBudgetMs?: number;
  pollIntervalMs?: number;
  /** Injectable transport for fixture gates (default global fetch). */
  fetchImpl?: typeof fetch;
}

const RISK_NAMES = ['informational', 'low', 'medium', 'high'] as const;

function normalizeRisk(raw: string): (typeof RISK_NAMES)[number] {
  const numeric = Number(raw);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 3) {
    const byLevel = RISK_NAMES[numeric];
    if (byLevel !== undefined) return byLevel;
  }
  const named = RISK_NAMES.find((name) => name.toLowerCase() === raw.toLowerCase());
  if (named !== undefined) return named;
  throw new VisualAuditError(
    'INVALID_RISK',
    `ZAP alert risk ${JSON.stringify(raw)} is neither a 0-3 level nor a known risk name`
  );
}
const hostMatches = (hostname: string, pattern: string): boolean => {
  const host = hostname.toLowerCase();
  if (pattern.startsWith('.')) return host.endsWith(pattern);
  return host === pattern;
};

const SCOPE_PATTERN = /^\.?[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/;

export class ZapClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly allowedHosts: string[];
  private readonly pollBudgetMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ZapClientOptions) {
    if (options.allowedHosts.length === 0) {
      throw new VisualAuditError(
        'SCOPE_HOST_DENIED',
        'an empty engagement scope refuses every scanner target'
      );
    }
    for (const host of options.allowedHosts) {
      if (!SCOPE_PATTERN.test(host)) {
        throw new VisualAuditError(
          'INVALID_SCOPE',
          `scope entry ${JSON.stringify(host)} is not a host[:port] literal`
        );
      }
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.allowedHosts = options.allowedHosts.map((host) => host.toLowerCase());
    this.pollBudgetMs = options.pollBudgetMs ?? 120_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private inScope(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return this.allowedHosts.some((pattern) => hostMatches(host, pattern));
  }

  private async zapCall<T>(
    viewOrAction: string,
    parameters: Record<string, string> = {}
  ): Promise<T> {
    const query = new URLSearchParams({
      zapapiformat: 'JSON',
      formMethod: 'GET',
      ...(this.apiKey !== undefined ? { apikey: this.apiKey } : {}),
      ...parameters,
    });
    const response = await this.fetchImpl(`${this.baseUrl}${viewOrAction}?${query.toString()}`);
    if (!response.ok) {
      // ZAP reports scanner-side causes in the body (url_not_found, scoped
      // access, add-on state) — carry a bounded excerpt so operators see the
      // scanner's cause, not just an HTTP number.
      const body = (await response.text()).slice(0, 200);
      throw new VisualAuditError(
        'SCANNER_UNAVAILABLE',
        `ZAP ${viewOrAction} returned HTTP ${response.status}: ${body}`
      );
    }
    return (await response.json()) as T;
  }

  async version(): Promise<string> {
    const reply = await this.zapCall<{ version: string }>('/JSON/core/view/version/');
    return reply.version;
  }

  async newSession(): Promise<void> {
    await this.zapCall('/JSON/core/action/newSession/');
  }

  /** Start an active scan against an in-scope target, poll to completion
   * within the budget, and return scope-filtered normalized findings. */
  async scan(target: string): Promise<ScannerScanResult> {
    const parsed = new URL(target);
    const targetHost = parsed.host.toLowerCase();
    if (!this.inScope(targetHost)) {
      throw new VisualAuditError(
        'POLICY_DENIED',
        `SCOPE_HOST_DENIED: scan target ${targetHost} is outside the engagement scope`
      );
    }
    const started = await this.zapCall<{ scan: string }>('/JSON/ascan/action/scan/', {
      url: target,
    });
    const scanId = Number(started.scan);
    if (!Number.isFinite(scanId)) {
      throw new VisualAuditError('SCANNER_UNAVAILABLE', 'ZAP did not return a scan id');
    }
    const deadline = Date.now() + this.pollBudgetMs;
    for (;;) {
      const status = await this.zapCall<{ status: string }>('/JSON/ascan/view/status/', {
        scanId: String(scanId),
      });
      if (Number(status.status) >= 100) break;
      if (Date.now() + this.pollIntervalMs > deadline) {
        // Stop the runaway scan server-side; the stop is best-effort — the
        // typed budget failure is the contract either way.
        await this.zapCall('/JSON/ascan/action/stop/', { scanId: String(scanId) }).catch(() => {});
        throw new VisualAuditError(
          'SCAN_BUDGET_EXHAUSTED',
          `scan ${scanId} exceeded the ${this.pollBudgetMs}ms budget at ${status.status}%`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    // baseurl is the ORIGIN, not the target path: ZAP prefix-filters alert
    // URIs, and a path target would silently hide sibling-path alerts from
    // the same site tree the scan actually covered.
    const alertsReply = await this.zapCall<{
      alerts: Array<{
        pluginId: string;
        url: string;
        param: string;
        risk: string;
        name: string;
      }>;
    }>('/JSON/core/view/alerts/', { baseurl: parsed.origin, start: '0' });
    let droppedOutOfScope = 0;
    const findings: ScannerFinding[] = [];
    for (const alert of alertsReply.alerts) {
      const alertHost = new URL(alert.url).host.toLowerCase();
      if (!this.inScope(alertHost)) {
        droppedOutOfScope += 1;
        continue;
      }
      findings.push({
        pluginId: Number(alert.pluginId),
        url: alert.url,
        parameter: alert.param === '' ? null : alert.param,
        risk: normalizeRisk(alert.risk),
        name: alert.name,
      });
    }
    const scannerVersion = await this.version();
    return { scannerVersion, scanId, findings, droppedOutOfScope };
  }
}

export interface ScannerFindingSignature {
  pluginId: number;
  url: string;
  parameter: string | null;
}

export interface ScannerBaseline {
  formatVersion: 1;
  findings: ScannerFindingSignature[];
  capturedAt: string;
}

const signatureOf = (finding: ScannerFindingSignature): string =>
  `${finding.pluginId}::${finding.url}::${finding.parameter ?? ''}`;

export interface ScannerComparison {
  verdict: 'clean' | 'within-baseline' | 'regression';
  newFindings: ScannerFinding[];
  /** Signature keys acknowledged at baseline that no longer appear. */
  resolved: string[];
}

/** Acknowledged-set comparison over scanner findings (slice 1's
 * baseline semantics, over (pluginId, url, parameter) signatures). */
export function compareScannerFindings(
  result: ScannerScanResult,
  baseline: ScannerBaseline
): ScannerComparison {
  const acknowledged = new Set(baseline.findings.map(signatureOf));
  const baselineSignatures = new Set(baseline.findings.map(signatureOf));
  const newFindings = result.findings.filter((finding) => !acknowledged.has(signatureOf(finding)));
  const currentSignatures = new Set(result.findings.map(signatureOf));
  const resolved = [...baselineSignatures].filter((signature) => !currentSignatures.has(signature));
  const verdict: ScannerComparison['verdict'] =
    result.findings.length === 0
      ? 'clean'
      : newFindings.length > 0
        ? 'regression'
        : 'within-baseline';
  return { verdict, newFindings, resolved };
}
