// T10 M3: findings bound to an engagement ledger, exported as a SARIF draft.
import { ENGAGEMENT_GENESIS, engagementChainHash } from '@agentbrowser/core';
import { describe, expect, it } from 'vitest';
import { buildEngagementSarif, checkEngagementFindings } from './engagement-findings.js';

/** A hash-chained ledger, built the way the server writes one. */
function ledger(records: Array<{ type: string; data: Record<string, unknown> }>, close = true) {
  let prev = ENGAGEMENT_GENESIS;
  const lines: string[] = [];
  const all = close
    ? [...records, { type: 'engagement.closed', data: { records: records.length } }]
    : records;
  all.forEach((record, seq) => {
    const at = `2026-10-17T00:00:0${seq % 10}.000Z`;
    const body = JSON.stringify({ seq, at, type: record.type, data: record.data });
    const hash = engagementChainHash(prev, body);
    lines.push(JSON.stringify({ seq, at, type: record.type, data: record.data, prev, hash }));
    prev = hash;
  });
  return `${lines.join('\n')}\n`;
}

const scope = {
  allowedHosts: ['.acme.test'],
  pathRules: [],
  identityBindings: [],
  expired: false,
  denials: {},
  excludePaths: [{ prefix: '/logout' }],
  program: { id: 'acme', authorizedBy: 'r@example.test', authorizedAt: '2026-10-17T00:00:00Z' },
};
const opened = {
  type: 'engagement.opened',
  data: { engagementId: 'eng_aaaaaaaaaaaaaaaaaaaaaaaa', scope },
};
const request = (url: string, extra: Record<string, unknown> = {}) => ({
  type: 'request',
  data: { outcome: 'finished', method: 'GET', url, status: 200, ...extra },
});
const evidence = {
  method: 'independent-reproduction' as const,
  reproducedAt: '2026-10-17T01:00:00Z',
  observation: 'Second account read the first account invoice by id.',
  cleanup: { required: false, performed: false, note: 'read-only' },
};
const text = ledger([
  opened,
  request('https://app.acme.test/api/invoices/7'),
  request('https://app.acme.test/admin', { blocked: true, scope: 'SCOPE_PATH_DENIED' }),
  request('https://other.test/x', { blocked: true, scope: 'SCOPE_HOST_DENIED' }),
]);
const confirmed = {
  id: 'F-1',
  title: 'IDOR on invoices',
  severity: 'high',
  status: 'confirmed',
  url: 'https://app.acme.test/api/invoices/7?view=full',
  description: 'Invoices are readable across accounts.',
  ledgerRefs: [1],
  evidence,
};

describe('checkEngagementFindings (T10 M3)', () => {
  it('accepts an in-scope confirmed finding that cites an unblocked request to its URL', () => {
    const result = checkEngagementFindings(text, [confirmed]);
    expect(result).toMatchObject({
      ok: true,
      engagementId: 'eng_aaaaaaaaaaaaaaaaaaaaaaaa',
      closed: true,
    });
  });

  it.each([
    ['an out-of-scope URL', { url: 'https://other.test/x' }, /outside the engagement scope/],
    ['an excluded path', { url: 'https://app.acme.test/logout' }, /outside the engagement scope/],
    ['a reference to a blocked request', { ledgerRefs: [2] }, /blocked/],
    ['a reference to a missing record', { ledgerRefs: [99] }, /no ledger record 99/],
    ['a reference to a non-request record', { ledgerRefs: [0] }, /not a request/],
    [
      'a reference to a different path',
      { url: 'https://app.acme.test/api/invoices/8' },
      /does not match/,
    ],
    ['a confirmed finding without references', { ledgerRefs: [] }, /cite at least one/],
    ['a confirmed finding without evidence', { evidence: undefined }, /evidence/],
    [
      'scanner confidence as evidence',
      { evidence: { ...evidence, method: 'scanner' } },
      /independent-reproduction/,
    ],
    ['a method that does not match the request', { method: 'POST' }, /does not match/],
  ])('refuses %s', (_what, patch, message) => {
    const result = checkEngagementFindings(text, [{ ...confirmed, ...patch }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => `${issue.findingId}: ${issue.issue}`).join('\n')).toMatch(
      message
    );
  });

  it('a suspected finding needs scope, not references or evidence', () => {
    const suspected = {
      id: 'F-2',
      title: 'Possible XSS',
      severity: 'medium',
      status: 'suspected',
      url: 'https://www.acme.test/search',
      description: 'Reflected parameter.',
    };
    expect(checkEngagementFindings(text, [suspected]).ok).toBe(true);
  });

  it('refuses a ledger whose chain is broken, and warns when it is not closed', () => {
    const tampered = text.replace('/api/invoices/7', '/api/invoices/9');
    const broken = checkEngagementFindings(tampered, [confirmed]);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.issues[0]?.issue).toMatch(/chain/);
    const open = checkEngagementFindings(
      ledger([opened, request('https://app.acme.test/api/invoices/7')], false),
      [confirmed]
    );
    expect(open).toMatchObject({ ok: true, closed: false });
    if (open.ok) expect(open.warnings.join(' ')).toMatch(/not closed/);
  });

  it('refuses malformed findings and duplicate ids', () => {
    expect(checkEngagementFindings(text, 'nope').ok).toBe(false);
    expect(checkEngagementFindings(text, [{ ...confirmed, severity: 'urgent' }]).ok).toBe(false);
    expect(checkEngagementFindings(text, [confirmed, confirmed]).ok).toBe(false);
    expect(checkEngagementFindings(text, [{ ...confirmed, url: 'javascript:alert(1)' }]).ok).toBe(
      false
    );
  });
});

describe('buildEngagementSarif (T10 M3)', () => {
  it('emits a manual-submission SARIF draft citing the engagement and ledger entries', () => {
    const check = checkEngagementFindings(text, [confirmed]);
    if (!check.ok) throw new Error('expected ok');
    const sarif = buildEngagementSarif(check, '1.25.0');
    expect(sarif.version).toBe('2.1.0');
    const run = sarif.runs[0]!;
    expect(run.properties).toMatchObject({
      draft: true,
      submission: 'manual',
      engagementId: 'eng_aaaaaaaaaaaaaaaaaaaaaaaa',
      program: { id: 'acme' },
    });
    const result = run.results[0]!;
    expect(result).toMatchObject({
      level: 'error',
      kind: 'fail',
      partialFingerprints: { findingId: 'F-1' },
      properties: {
        status: 'confirmed',
        ledgerRefs: [1],
        engagementId: 'eng_aaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    expect(result.locations?.[0]?.physicalLocation?.artifactLocation?.uri).toBe(
      'https://app.acme.test/api/invoices/7?view=full'
    );
  });
});
