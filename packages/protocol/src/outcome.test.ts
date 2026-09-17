import { describe, expect, it } from 'vitest';
import {
  OutcomeRunReportSchema,
  OutcomeRunRequestSchema,
  createOutcomeRunReportParser,
  isPassingOutcome,
  parseOutcomeProjection,
  parseOutcomeRunReport,
  parseOutcomeRunRequest,
} from './outcome.js';

const passing = () => ({
  availability: 'available',
  execution: 'completed',
  verification: {
    status: 'passed',
    verifier: { id: 'native-input', version: '1.0.0' },
    requiredLayer: 'G5',
    achievedLayer: 'G5',
    evidenceRefIds: ['ev_native_1'],
  },
  cleanup: 'complete',
  testedSeam: 'ui',
});

describe('canonical outcome projection', () => {
  it('derives a pass only from independently satisfied axes', () => {
    expect(isPassingOutcome(passing())).toBe(true);
    expect(isPassingOutcome({ ...passing(), cleanup: 'not_needed' })).toBe(true);

    for (const outcome of [
      { ...passing(), availability: 'blocked' },
      { ...passing(), availability: 'unsupported' },
      { ...passing(), execution: 'failed' },
      { ...passing(), execution: 'unknown' },
      { ...passing(), cleanup: 'pending' },
      { ...passing(), cleanup: 'failed' },
      { ...passing(), cleanup: 'unknown' },
      {
        ...passing(),
        verification: {
          status: 'not_requested',
          requiredLayer: 'G5',
          evidenceRefIds: [],
        },
      },
      {
        ...passing(),
        verification: {
          ...passing().verification,
          status: 'failed',
        },
      },
      {
        ...passing(),
        verification: {
          ...passing().verification,
          status: 'unknown',
        },
      },
    ]) {
      expect(isPassingOutcome(outcome)).toBe(false);
    }
  });

  it('rejects a claimed pass below the required grounding layer', () => {
    expect(() =>
      parseOutcomeProjection({
        ...passing(),
        verification: { ...passing().verification, requiredLayer: 'G6', achievedLayer: 'G4' },
      })
    ).toThrow('Invalid outcome projection');
  });

  it('rejects private, inherited, accessor-backed and cyclic report data', () => {
    for (const verification of [
      { ...passing().verification, actual: 'PRIVATE-ACTUAL' },
      Object.assign(Object.create({ actual: 'PRIVATE-INHERITED' }), passing().verification),
    ]) {
      expect(() => parseOutcomeProjection({ ...passing(), verification })).toThrow(
        'Invalid outcome projection'
      );
    }

    let reads = 0;
    const accessor = Object.defineProperty(passing(), 'cleanup', {
      enumerable: true,
      get: () => {
        reads++;
        return 'complete';
      },
    });
    expect(() => parseOutcomeProjection(accessor)).toThrow('Invalid outcome projection');
    expect(reads).toBe(0);

    const cycle = passing() as ReturnType<typeof passing> & { self?: unknown };
    cycle.self = cycle;
    expect(() => parseOutcomeProjection(cycle)).toThrow('Invalid outcome projection');
    try {
      parseOutcomeProjection({
        ...passing(),
        verification: { ...passing().verification, actual: 'PRIVATE-ACTUAL' },
      });
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE-ACTUAL');
    }
  });

  it('returns a detached bounded projection and rejects caller-supplied pass flags', () => {
    const input = passing();
    const parsed = parseOutcomeProjection(input);
    input.verification.evidenceRefIds[0] = 'PRIVATE-MUTATION';
    expect(parsed.verification.evidenceRefIds).toEqual(['ev_native_1']);
    expect(() => parseOutcomeProjection({ ...passing(), pass: true })).toThrow(
      'Invalid outcome projection'
    );
    expect(() =>
      parseOutcomeProjection({
        ...passing(),
        verification: {
          ...passing().verification,
          evidenceRefIds: Array.from({ length: 33 }, (_, index) => `ev_${index}`),
        },
      })
    ).toThrow('Invalid outcome projection');
  });
});

const runRequest = () => ({
  actions: [
    {
      action: 'fill',
      target: { ref: 'e1_0' },
      value: 'PRIVATE-WRITTEN',
      expectValue: 'PRIVATE-EXPECTED',
    },
  ],
  verification: {
    verifier: { id: 'application-state', version: '1.0.0' },
    input: { recordRef: 'opaque-record-ref' },
  },
});

const runReport = () => ({
  plan: {
    ok: true,
    completed: 1,
    results: [{ step: 0, ok: true, result: { verified: true } }],
  },
  outcome: {
    ...passing(),
    verification: {
      ...passing().verification,
      verifier: { id: 'application-state', version: '1.0.0' },
    },
    testedSeam: 'application',
  },
});

describe('outcome run contracts', () => {
  it('defines strict request and report envelopes without aggregate success flags', () => {
    expect(OutcomeRunRequestSchema.$id).toBe('urn:agentbrowser:outcome-run-request:v1');
    expect(OutcomeRunReportSchema.$id).toBe('urn:agentbrowser:outcome-run-report:v1');

    expect(parseOutcomeRunRequest(runRequest())).toEqual(runRequest());
    expect(parseOutcomeRunReport(runReport())).toEqual(runReport());
    expect(() => parseOutcomeRunRequest({ ...runRequest(), future: true })).toThrow(
      'Invalid outcome run request'
    );
    expect(() => parseOutcomeRunRequest({ ...runRequest(), actions: [] })).toThrow(
      'Invalid outcome run request'
    );
    expect(() => parseOutcomeRunReport({ ...runReport(), ok: true })).toThrow(
      'Invalid outcome run report'
    );
    expect(() => parseOutcomeRunReport({ ...runReport(), pass: true })).toThrow(
      'Invalid outcome run report'
    );
  });

  it('returns detached bounded request data without reading accessors or exposing values', () => {
    const request = runRequest();
    const parsed = parseOutcomeRunRequest(request);
    const firstAction = request.actions[0];
    expect(firstAction).toBeDefined();
    if (firstAction === undefined) throw new Error('fixture action missing');
    firstAction.value = 'PRIVATE-MUTATION';
    (request.verification.input as { recordRef: string }).recordRef = 'PRIVATE-MUTATION';
    expect(parsed.actions[0]?.value).toBe('PRIVATE-WRITTEN');
    expect(parsed.verification.input).toEqual({ recordRef: 'opaque-record-ref' });

    let reads = 0;
    const accessor = Object.defineProperty(runRequest(), 'actions', {
      enumerable: true,
      get: () => {
        reads++;
        return [];
      },
    });
    expect(() => parseOutcomeRunRequest(accessor)).toThrow('Invalid outcome run request');
    expect(reads).toBe(0);

    const cyclic = runRequest() as ReturnType<typeof runRequest> & { cycle?: unknown };
    cyclic.verification.input = cyclic;
    expect(() => parseOutcomeRunRequest(cyclic)).toThrow('Invalid outcome run request');

    let deep: unknown = 'leaf';
    for (let index = 0; index < 17; index++) deep = { next: deep };
    expect(() =>
      parseOutcomeRunRequest({
        ...runRequest(),
        verification: { ...runRequest().verification, input: deep },
      })
    ).toThrow('Invalid outcome run request');

    const oversized = {
      ...runRequest(),
      verification: {
        ...runRequest().verification,
        input: { secret: 'PRIVATE-VERIFIER-INPUT', oversized: 'x'.repeat(65_537) },
      },
    };
    expect(() => parseOutcomeRunRequest(oversized)).toThrow('Invalid outcome run request');
    try {
      parseOutcomeRunRequest(oversized);
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE-VERIFIER-INPUT');
    }
  });

  it('pins request-relative plan requirements and verifier identity', () => {
    const request = runRequest();
    const parse = createOutcomeRunReportParser(request);
    const firstAction = request.actions[0];
    expect(firstAction).toBeDefined();
    if (firstAction === undefined) throw new Error('fixture action missing');
    firstAction.expectValue = undefined;
    request.verification.verifier.id = 'mutated-verifier';

    expect(parse(runReport())).toEqual(runReport());
    expect(() =>
      parse({
        ...runReport(),
        plan: { ok: true, completed: 1, results: [{ step: 0, ok: true }] },
      })
    ).toThrow('Invalid outcome run report');
    expect(() =>
      parse({
        ...runReport(),
        outcome: {
          ...runReport().outcome,
          verification: {
            ...runReport().outcome.verification,
            verifier: { id: 'mutated-verifier', version: '1.0.0' },
          },
        },
      })
    ).toThrow('Invalid outcome run report');
  });

  it.each([
    ['successful plan with failed execution', true, 'failed', 'failed'],
    ['failed plan with completed execution', false, 'completed', 'failed'],
    ['failed plan with not-started execution', false, 'not_started', 'unknown'],
    ['failed plan with running execution', false, 'running', 'unknown'],
    ['passed verification with failed execution', false, 'failed', 'passed'],
    ['passed verification with unknown execution', false, 'unknown', 'passed'],
    ['passed verification with not-started execution', false, 'not_started', 'passed'],
  ])('rejects %s', (_name, planOk, execution, verificationStatus) => {
    const report = runReport();
    report.plan = planOk
      ? report.plan
      : {
          ok: false,
          completed: 0,
          results: [{ step: 0, ok: false, error: 'write outcome uncertain' }],
        };
    report.outcome.execution = execution as typeof report.outcome.execution;
    report.outcome.verification.status =
      verificationStatus as typeof report.outcome.verification.status;
    if (verificationStatus === 'unknown') {
      report.outcome.verification = {
        status: 'unknown',
        verifier: { id: 'application-state', version: '1.0.0' },
        requiredLayer: 'G5',
        evidenceRefIds: [],
      } as typeof report.outcome.verification;
    }
    expect(() => parseOutcomeRunReport(report)).toThrow('Invalid outcome run report');
  });

  it('accepts failed or unknown execution for available failed plans', () => {
    for (const execution of ['failed', 'unknown'] as const) {
      const report = runReport();
      report.plan = {
        ok: false,
        completed: 0,
        results: [{ step: 0, ok: false, error: 'write outcome uncertain' }],
      };
      report.outcome.execution = execution;
      report.outcome.verification = {
        status: 'unknown',
        verifier: { id: 'application-state', version: '1.0.0' },
        requiredLayer: 'G5',
        evidenceRefIds: [],
      };
      expect(parseOutcomeRunReport(report)).toEqual(report);
    }
  });

  it.each(['blocked', 'unsupported'] as const)(
    'accepts a synthesized not-started plan when availability is %s',
    (availability) => {
      const report = runReport();
      report.plan = {
        ok: false,
        completed: 0,
        results: [],
        error: { code: 'PREFLIGHT_UNAVAILABLE', message: availability },
      };
      report.outcome.availability = availability;
      report.outcome.execution = 'not_started';
      report.outcome.verification = {
        status: 'unknown',
        verifier: { id: 'application-state', version: '1.0.0' },
        requiredLayer: 'G5',
        evidenceRefIds: [],
      };
      report.outcome.cleanup = 'not_needed';

      expect(createOutcomeRunReportParser(runRequest())(report)).toEqual(report);
    }
  );

  it('rejects available or nonempty not-started plan reports', () => {
    const unavailable = runReport();
    unavailable.plan = {
      ok: false,
      completed: 0,
      results: [],
      error: { code: 'PREFLIGHT_UNAVAILABLE', message: 'blocked' },
    };
    unavailable.outcome.execution = 'not_started';
    unavailable.outcome.verification = {
      status: 'unknown',
      verifier: { id: 'application-state', version: '1.0.0' },
      requiredLayer: 'G5',
      evidenceRefIds: [],
    };
    unavailable.outcome.cleanup = 'not_needed';

    expect(() => parseOutcomeRunReport(unavailable)).toThrow('Invalid outcome run report');
    expect(() =>
      parseOutcomeRunReport({
        ...unavailable,
        outcome: { ...unavailable.outcome, availability: 'blocked' },
        plan: {
          ...unavailable.plan,
          results: [{ step: 0, ok: false, error: 'preflight failed' }],
        },
      })
    ).toThrow('Invalid outcome run report');
  });

  it('returns a detached bounded report without reading accessors', () => {
    const report = runReport();
    const parse = createOutcomeRunReportParser(runRequest());
    const parsed = parse(report);
    const firstResult = report.plan.results[0];
    expect(firstResult).toBeDefined();
    if (firstResult === undefined) throw new Error('fixture result missing');
    firstResult.result = { verified: false };
    report.outcome.verification.evidenceRefIds[0] = 'PRIVATE-MUTATION';
    expect(parsed.plan.results[0]?.result).toEqual({ verified: true });
    expect(parsed.outcome.verification.evidenceRefIds).toEqual(['ev_native_1']);

    let reads = 0;
    const accessor = Object.defineProperty(runReport(), 'plan', {
      enumerable: true,
      get: () => {
        reads++;
        return runReport().plan;
      },
    });
    expect(() => parse(accessor)).toThrow('Invalid outcome run report');
    expect(reads).toBe(0);

    const cyclic = runReport() as ReturnType<typeof runReport> & { cycle?: unknown };
    cyclic.cycle = cyclic;
    expect(() => parse(cyclic)).toThrow('Invalid outcome run report');

    const oversized = runReport();
    const oversizedResult = oversized.plan.results[0];
    expect(oversizedResult).toBeDefined();
    if (oversizedResult === undefined) throw new Error('fixture result missing');
    oversizedResult.result = {
      verified: true,
      secret: 'PRIVATE-REPORT',
      value: 'x'.repeat(65_537),
    };
    expect(() => parse(oversized)).toThrow('Invalid outcome run report');
    try {
      parse(oversized);
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE-REPORT');
    }
  });
});
