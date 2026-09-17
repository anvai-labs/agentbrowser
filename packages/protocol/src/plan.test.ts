import { describe, expect, it } from 'vitest';
import { PlanActionsSchema, PlanReportSchema, parsePlanReport, parsePlanSteps } from './plan.js';

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
});
