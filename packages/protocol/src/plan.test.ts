import { describe, expect, it } from 'vitest';
import {
  PlanActionsSchema,
  PlanReportSchema,
  createPlanReportParser,
  parsePlanReport,
  parsePlanSteps,
} from './plan.js';

describe('canonical plan contracts', () => {
  it('retains nested input constraints and existing empty-plan/extension compatibility', () => {
    expect(PlanActionsSchema.items.properties.waitMs.maximum).toBe(60000);
    expect(PlanActionsSchema.items.properties.count.maximum).toBe(20);
    expect(parsePlanSteps([])).toEqual([]);
    const steps = [
      { action: 'fill', waitForLabel: 'Name', waitMs: 100, value: 'value', futureField: true },
    ];
    expect(parsePlanSteps(steps)).toEqual(steps);
  });

  it.each([
    undefined,
    {},
    [null],
    [{ action: 'press', count: 21 }],
    [{ action: 'fill', waitForLabel: 'Name', waitMs: 'PRIVATE-VALUE' }],
    [{ action: { type: 'click' } }],
  ])('rejects malformed steps without echoing values', (steps) => {
    expect(() => parsePlanSteps(steps)).toThrow();
    try {
      parsePlanSteps(steps);
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE-VALUE');
    }
  });

  it('preserves complete partial reports and optional legacy metadata', () => {
    expect(PlanReportSchema.$id).toBe('urn:agentbrowser:plan-report:v1');
    const partial = {
      ok: false,
      completed: 1,
      results: [
        {
          step: 0,
          ok: true,
          actionId: 'a',
          remap: { from: 'e1_0', to: 'e2_0' },
          result: { evidence: 'value' },
        },
        { step: 1, ok: false, error: 'denied' },
      ],
      mode: 'verified',
      newRevision: 2,
      error: { code: 'PLAN_STEP_FAILED', message: 'denied' },
    };
    expect(parsePlanReport(partial)).toEqual(partial);
    expect(parsePlanReport({ ok: true, completed: 0, results: [] })).toEqual({
      ok: true,
      completed: 0,
      results: [],
    });
    expect(() =>
      parsePlanReport({ ok: true, completed: 1, results: [{ step: 0, ok: true }] }, 2)
    ).toThrow('may have executed');
  });

  it.each([
    { ok: true, completed: -1, results: [] },
    { ok: false, completed: 0, results: [{ step: 0, ok: 'PRIVATE-REPORT' }] },
  ])('rejects malformed reports with uncertainty guidance', (report) => {
    expect(() => parsePlanReport(report)).toThrow('may have executed');
    try {
      parsePlanReport(report);
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE-REPORT');
    }
  });

  it.each([
    {
      ok: true,
      completed: 0,
      results: [{ step: 0, ok: false, error: 'PRIVATE-REPORT' }],
    },
    { ok: true, completed: 1, results: [] },
    { ok: true, completed: 0, results: [{ step: 0, ok: true }] },
    { ok: true, completed: 1, results: [{ step: 1, ok: true }] },
    {
      ok: true,
      completed: 1,
      results: [{ step: 0, ok: true, error: 'PRIVATE-REPORT' }],
    },
    {
      ok: true,
      completed: 1,
      results: [{ step: 0, ok: true }],
      error: { code: 'REMOTE_FAILURE', message: 'PRIVATE-REPORT' },
    },
  ])('rejects contradictory aggregate success without exposing the report', (report) => {
    expect(() => parsePlanReport(report)).toThrow(/^Invalid plan report.*may have executed/);
    try {
      parsePlanReport(report);
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE-REPORT');
    }
  });

  it('requires value-free evidence for every fill that requested verification', () => {
    const action = {
      action: 'fill',
      target: { ref: 'e1_0' },
      value: 'PRIVATE-WRITTEN',
      expectValue: 'PRIVATE-EXPECTED',
    };
    const parse = createPlanReportParser([action]);
    (action as { expectValue?: string }).expectValue = undefined;

    for (const result of [
      undefined,
      false,
      [],
      {},
      { verified: false },
      { verified: true, actual: 'PRIVATE-READBACK', expected: 'PRIVATE-EXPECTED' },
      Object.assign(Object.create(null), { verified: true }),
    ]) {
      const report = {
        ok: true,
        completed: 1,
        results: [{ step: 0, ok: true, ...(result !== undefined ? { result } : {}) }],
      };
      expect(() => parse(report)).toThrow('may have executed');
      try {
        parse(report);
      } catch (error) {
        expect(String(error)).not.toContain('PRIVATE-WRITTEN');
        expect(String(error)).not.toContain('PRIVATE-EXPECTED');
        expect(String(error)).not.toContain('PRIVATE-READBACK');
      }
    }

    const inherited = Object.create({ verified: true });
    expect(() =>
      parse({ ok: true, completed: 1, results: [{ step: 0, ok: true, result: inherited }] })
    ).toThrow('may have executed');
    expect(
      parse({
        ok: true,
        completed: 1,
        results: [{ step: 0, ok: true, result: { verified: true } }],
      })
    ).toMatchObject({ ok: true });

    let accessorReads = 0;
    const accessor = Object.defineProperty({}, 'verified', {
      enumerable: true,
      get: () => (++accessorReads === 1 ? true : 'PRIVATE-READBACK'),
    });
    expect(() =>
      parse({ ok: true, completed: 1, results: [{ step: 0, ok: true, result: accessor }] })
    ).toThrow('may have executed');
    expect(accessorReads).toBe(0);

    const mutable = { verified: true as boolean | string };
    const projected = parse({
      ok: true,
      completed: 1,
      results: [{ step: 0, ok: true, result: mutable }],
    });
    mutable.verified = 'PRIVATE-READBACK';
    expect(projected.results[0]?.result).toEqual({ verified: true });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE-READBACK');

    let reportReads = 0;
    const unstableReport = {
      get ok() {
        reportReads++;
        return reportReads === 1;
      },
      completed: 1,
      results: [{ step: 0, ok: true, result: { verified: true } }],
    };
    expect(() => parse(unstableReport)).toThrow('may have executed');
    expect(reportReads).toBe(0);

    let rowReads = 0;
    const unstableRow = {
      step: 0,
      get ok() {
        rowReads++;
        return rowReads < 3;
      },
      result: { verified: true },
    };
    expect(() => parse({ ok: true, completed: 1, results: [unstableRow] })).toThrow(
      'may have executed'
    );
    expect(rowReads).toBe(0);
  });

  it('does not invent verification requirements for ordinary or failed plans', () => {
    const parse = createPlanReportParser([
      { action: 'click', target: { ref: 'e1_0' } },
      { action: 'fill', target: { ref: 'e1_1' }, value: 'value' },
    ]);
    expect(
      parse({
        ok: true,
        completed: 2,
        results: [
          { step: 0, ok: true },
          { step: 1, ok: true },
        ],
      })
    ).toMatchObject({ ok: true });
    expect(
      createPlanReportParser([
        { action: 'fill', target: { ref: 'e1_0' }, value: 'x', expectValue: 'x' },
      ])({ ok: false, completed: 0, results: [{ step: 0, ok: false, error: 'failed' }] })
    ).toMatchObject({ ok: false });
  });
});
