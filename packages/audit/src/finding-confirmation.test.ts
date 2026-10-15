import { describe, expect, it } from 'vitest';
import { type ConfirmationEvidence, confirmFinding } from './finding-confirmation.js';
import type { ScannerFinding } from './scanner-regression.js';

const suspected: ScannerFinding = {
  pluginId: 40012,
  url: 'http://target.testhost.example/item?name=x',
  parameter: 'name',
  risk: 'high',
  name: 'Cross Site Scripting (Reflected)',
  status: 'suspected',
  scannerConfidence: 'medium',
};

const evidence: ConfirmationEvidence = {
  method: 'independent-reproduction',
  reproducedAt: '2026-10-15T10:00:00.000Z',
  observation: 'payload marker reflected unescaped in the response body',
  cleanup: { required: false, performed: false, note: 'read-only GET, nothing to clean up' },
};

describe('finding confirmation (T7: confirmed needs independent evidence and cleanup)', () => {
  it('confirms a suspected finding only with independent evidence attached', () => {
    const confirmed = confirmFinding(suspected, evidence);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.evidence).toEqual(evidence);
    // The scanner's own confidence is kept as information; it is not the confirmation.
    expect(confirmed.scannerConfidence).toBe('medium');
    // The input finding is not mutated: suspected stays suspected.
    expect(suspected.status).toBe('suspected');
  });

  it('refuses a confirmation whose required cleanup was not performed', () => {
    expect(() =>
      confirmFinding(suspected, {
        ...evidence,
        cleanup: { required: true, performed: false, note: 'created a test record' },
      })
    ).toThrow(/CLEANUP_INCOMPLETE|cleanup/);
    expect(
      confirmFinding(suspected, {
        ...evidence,
        cleanup: { required: true, performed: true, note: 'test record deleted' },
      }).status
    ).toBe('confirmed');
  });

  it('refuses missing or empty evidence and a scanner opinion posing as evidence', () => {
    for (const bad of [
      { ...evidence, method: 'scanner-confidence' },
      { ...evidence, observation: '   ' },
      { ...evidence, reproducedAt: 'yesterday' },
      { ...evidence, cleanup: undefined },
    ]) {
      expect(() => confirmFinding(suspected, bad as unknown as ConfirmationEvidence)).toThrow(
        /INVALID_EVIDENCE|evidence/
      );
    }
  });

  it('refuses to re-confirm a finding that is not suspected', () => {
    const confirmed = confirmFinding(suspected, evidence);
    expect(() => confirmFinding(confirmed, evidence)).toThrow(/suspected/);
  });
});
