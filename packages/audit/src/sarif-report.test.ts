import { describe, expect, it } from 'vitest';
import type { AccessibilityAuditResult } from './accessibility-audit.js';
import { buildSarifReport } from './sarif-report.js';
import type { ScannerScanResult } from './scanner-regression.js';

const a11yResult: AccessibilityAuditResult = {
  verdict: 'violations',
  violations: [
    {
      ruleId: 'image-alt',
      impact: 'critical',
      help: 'Images must have alternate text',
      targets: [['img[src="x.png"]']],
      nodeCount: 1,
    },
    {
      ruleId: 'button-name',
      impact: 'critical',
      help: 'Buttons must have discernible text',
      targets: [['button']],
      nodeCount: 1,
    },
    {
      ruleId: 'region',
      impact: 'moderate',
      help: 'Page content should be in landmarks',
      targets: [['body > p']],
      nodeCount: 1,
    },
  ],
  incompleteRules: ['color-contrast'],
  passesCount: 4,
};

const scannerResult: ScannerScanResult = {
  scannerVersion: '2.14.0-fixture',
  scanId: 1,
  findings: [
    {
      pluginId: 40012,
      url: 'http://target.testhost.example/item?name=<script>',
      parameter: 'name',
      risk: 'high',
      name: 'Cross Site Scripting (Reflected)',
      status: 'suspected',
      scannerConfidence: 'medium',
    },
    {
      pluginId: 10038,
      url: 'http://target.testhost.example/item',
      parameter: null,
      risk: 'medium',
      name: 'CSP Header Not Set',
      status: 'suspected',
    },
  ],
  droppedOutOfScope: 0,
};

describe('SARIF report adapter (T7 slice 4)', () => {
  it('gate 1: valid SARIF 2.1.0 structure with accessibility results', () => {
    const report = buildSarifReport({ accessibility: a11yResult });
    expect(report.version).toBe('2.1.0');
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].tool.driver.name).toBe('agentbrowser-audit-accessibility');
    expect(report.runs[0].results).toHaveLength(3);
    // Rules deduplicate by id.
    expect(report.runs[0].tool.driver.rules).toHaveLength(3);
  });

  it('gate 2: impact-to-level mapping (critical→error, moderate→warning)', () => {
    const report = buildSarifReport({ accessibility: a11yResult });
    const levels = report.runs[0].results.map((r) => r.level);
    expect(levels).toContain('error');
    expect(levels).toContain('warning');
  });

  it('gate 3: scanner findings produce pluginId ruleIds and url locations', () => {
    const report = buildSarifReport({ scanner: scannerResult });
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].tool.driver.name).toBe('agentbrowser-audit-scanner');
    expect(report.runs[0].results).toHaveLength(2);
    const xssResult = report.runs[0].results.find((r) => r.ruleId === '40012');
    // Suspected (unconfirmed) results carry level 'none' per SARIF 2.1.0 §3.27.10; the scanner's
    // risk rides in properties and in the rule's defaultConfiguration.
    expect(xssResult?.level).toBe('none');
    expect(xssResult?.properties).toMatchObject({ risk: 'high' });
    expect(
      report.runs[0].tool.driver.rules.find((rule) => rule.id === '40012')?.defaultConfiguration
    ).toEqual({ level: 'error' });
    // The URI is percent-encoded for SARIF conformance.
    expect(xssResult?.locations?.[0]?.physicalLocation?.artifactLocation?.uri).toBe(
      'http://target.testhost.example/item?name=%3Cscript%3E'
    );
    // Rules deduplicate by pluginId.
    expect(report.runs[0].tool.driver.rules).toHaveLength(2);
  });

  it('gate 4: both adapters combine into two runs', () => {
    const report = buildSarifReport({
      accessibility: a11yResult,
      scanner: scannerResult,
    });
    expect(report.runs).toHaveLength(2);
    expect(report.runs[0].tool.driver.name).toContain('accessibility');
    expect(report.runs[1].tool.driver.name).toContain('scanner');
  });

  it('gate 5: absent adapters produce empty runs (no crash)', () => {
    const report = buildSarifReport({});
    expect(report.runs).toHaveLength(0);
    expect(report.version).toBe('2.1.0');
  });

  it('gate 6: partialFingerprints are deterministic for scanner findings', () => {
    const report1 = buildSarifReport({ scanner: scannerResult });
    const report2 = buildSarifReport({ scanner: scannerResult });
    const fp1 = report1.runs[0].results.map((r) => r.partialFingerprints?.pluginIdUrl);
    const fp2 = report2.runs[0].results.map((r) => r.partialFingerprints?.pluginIdUrl);
    expect(fp1).toEqual(fp2);
  });

  it('gate 7: the output is valid JSON and parses cleanly', () => {
    const report = buildSarifReport({
      accessibility: a11yResult,
      scanner: scannerResult,
    });
    const text = JSON.stringify(report);
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.runs).toHaveLength(2);
  });

  it('gate 8 (T7): suspected stays labelled as SARIF review; confirmed is fail with its evidence', async () => {
    const { confirmFinding } = await import('@agentbrowser/engagement');
    const [xss, csp] = scannerResult.findings;
    if (!xss || !csp) throw new Error('fixture');
    const confirmed = confirmFinding(xss, {
      method: 'independent-reproduction',
      reproducedAt: '2026-10-15T10:00:00.000Z',
      observation: 'payload marker reflected unescaped',
      cleanup: { required: false, performed: false, note: 'read-only' },
    });
    const report = buildSarifReport({
      scanner: { ...scannerResult, findings: [confirmed, csp] },
    });
    const results = report.runs[0]?.results ?? [];
    expect(results[0]).toMatchObject({
      kind: 'fail',
      properties: {
        status: 'confirmed',
        scannerConfidence: 'medium',
        evidence: { method: 'independent-reproduction', reproducedAt: '2026-10-15T10:00:00.000Z' },
      },
    });
    expect(results[0]?.level).toBe('error');
    expect(results[1]).toMatchObject({
      kind: 'review',
      level: 'none',
      properties: { status: 'suspected' },
    });
    expect(results[1]?.properties).not.toHaveProperty('evidence');
    // SARIF 2.1.0 §3.27.9/§3.27.10: a kind other than 'fail' SHALL have level 'none', and a level
    // other than 'none' with kind present SHALL have kind 'fail'.
    for (const result of results) {
      if (result.kind !== undefined && result.kind !== 'fail') expect(result.level).toBe('none');
      if (result.kind !== undefined && result.level !== 'none') expect(result.kind).toBe('fail');
    }
  });

  it('gate 9 (T7): role-access findings get their own run, confirmed, without private markers', () => {
    const report = buildSarifReport({
      roleAccess: {
        findings: [
          {
            kind: 'broken-access-control',
            url: 'http://app.testhost.example/invoices/1001',
            owner: 'alice',
            actor: 'bob',
            risk: 'high',
            status: 'confirmed',
            evidence: {
              method: 'independent-reproduction',
              reproducedAt: '2026-10-15T10:00:00.000Z',
              observation: "identity bob received the owner's private marker (HTTP 200)",
              cleanup: { required: false, performed: false, note: 'read-only GET probe' },
            },
          },
        ],
        ownerControls: { passed: 1, failed: 0 },
      },
    });
    const run = report.runs.find((candidate) =>
      candidate.tool.driver.name.endsWith('-role-access')
    );
    expect(run?.results[0]).toMatchObject({
      ruleId: 'broken-access-control',
      level: 'error',
      kind: 'fail',
      properties: { status: 'confirmed', owner: 'alice', actor: 'bob' },
    });
  });
});
