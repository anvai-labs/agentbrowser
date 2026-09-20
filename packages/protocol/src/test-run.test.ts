import { describe, expect, it } from 'vitest';
import type { OutcomeRunReport, OutcomeRunRequest } from './outcome.js';
import {
  type AssertionInvocation,
  type TestCaseDescriptor,
  TestCaseDescriptorSchema,
  TestCaseEvaluationInputSchema,
  TestCaseEvaluationReportSchema,
  type TestCaseRunReport,
  TestCaseRunReportSchema,
  createTestCaseRunContract,
  evaluateTestCaseRun,
} from './test-run.js';

const request = (): OutcomeRunRequest => ({
  actions: [{ action: 'click', target: { ref: 'e1_0' } }],
  verification: {
    verifier: { id: 'fixture-commit', version: '1.0.0' },
    input: { operationId: 'PRIVATE-BUSINESS-ID' },
  },
});

const outcome = (overrides: Partial<OutcomeRunReport['outcome']> = {}): OutcomeRunReport => ({
  plan: { ok: true, completed: 1, results: [{ step: 0, ok: true }] },
  outcome: {
    availability: 'available',
    execution: 'completed',
    verification: {
      status: 'passed',
      verifier: { id: 'fixture-commit', version: '1.0.0' },
      requiredLayer: 'G4',
      achievedLayer: 'G4',
      evidenceRefIds: ['fixture-event-1'],
    },
    cleanup: 'complete',
    testedSeam: 'ui',
    ...overrides,
  },
});

const descriptor = (assertions = [{ id: 'commit', required: true }]): TestCaseDescriptor => ({
  id: 'counter-regression',
  version: '1.0.0',
  testedSeam: 'ui',
  environment: {
    productVersion: '1.9.0',
    cliVersion: '1.9.0',
    engine: { name: 'chromium', version: '140.0.0' },
    fixture: { id: 'versioned-counter', version: '1.0.0' },
  },
  assertions,
});

const invocation = (id = 'commit', operationId = 'assertion-op-1'): AssertionInvocation => ({
  id,
  operationId,
  request: request(),
});

const completed = (id = 'commit', operationId = 'assertion-op-1') => ({
  id,
  status: 'completed' as const,
  operationId,
  report: outcome(),
});

const report = (
  assertions: TestCaseRunReport['assertions'] = [completed()]
): TestCaseRunReport => ({
  case: { id: 'counter-regression', version: '1.0.0' },
  environment: descriptor().environment,
  setup: 'completed',
  assertions,
  cleanup: 'complete',
});

const evaluation = () => ({
  schemaVersion: 1 as const,
  descriptor: descriptor(),
  invocations: [invocation()],
  report: report(),
});

describe('bound test case run contract', () => {
  it('defines strict bounded descriptor and report schemas', () => {
    expect(TestCaseDescriptorSchema.$id).toBe('urn:agentbrowser:test-case-descriptor:v1');
    expect(TestCaseRunReportSchema.$id).toBe('urn:agentbrowser:test-case-run-report:v1');
    expect(TestCaseDescriptorSchema.properties.assertions.minItems).toBe(1);
    expect(TestCaseDescriptorSchema.properties.assertions.maxItems).toBe(16);
    expect(TestCaseRunReportSchema.properties.assertions.maxItems).toBe(16);
  });

  it('rejects a descriptor without a required regression assertion', () => {
    const allOptional = descriptor([
      { id: 'visual', required: false },
      { id: 'telemetry', required: false },
    ]);
    const completedOptionalReport = report([
      completed('visual', 'assertion-op-1'),
      completed('telemetry', 'assertion-op-2'),
    ]);
    expect(() =>
      createTestCaseRunContract(allOptional, [
        invocation('visual', 'assertion-op-1'),
        invocation('telemetry', 'assertion-op-2'),
      ]).isPassing(completedOptionalReport)
    ).toThrow('Invalid test case run contract');
  });

  it('parses and passes one exact request-relative UI assertion', () => {
    const contract = createTestCaseRunContract(descriptor(), [invocation()]);
    const input = report();
    const parsed = contract.parse(input);

    expect(parsed).toEqual(input);
    expect(contract.isPassing(parsed)).toBe(true);

    input.environment.productVersion = 'PRIVATE-MUTATION';
    const result = input.assertions[0];
    if (result?.status === 'completed') {
      result.report.outcome.verification.evidenceRefIds[0] = 'PRIVATE-MUTATION';
    }
    expect(parsed.environment.productVersion).toBe('1.9.0');
    expect(parsed.assertions[0]).toMatchObject({
      report: { outcome: { verification: { evidenceRefIds: ['fixture-event-1'] } } },
    });
  });

  it('captures descriptor and request-relative inputs once', () => {
    const expected = descriptor();
    const prepared = invocation();
    const contract = createTestCaseRunContract(expected, [prepared]);

    expected.id = 'mutated-case';
    expected.environment.productVersion = 'PRIVATE-MUTATION';
    prepared.operationId = 'mutated-operation';
    prepared.request.verification.verifier.id = 'mutated-verifier';
    prepared.request.actions.length = 0;

    expect(contract.isPassing(report())).toBe(true);
    expect(() =>
      contract.parse({ ...report(), case: { id: 'mutated-case', version: '1.0.0' } })
    ).toThrow('Invalid test case run report');
  });

  it('rejects malformed contract inputs without reading or echoing private data', () => {
    for (const assertions of [
      [],
      Array.from({ length: 17 }, (_, index) => ({ id: `assertion-${index}`, required: true })),
      [
        { id: 'duplicate', required: true },
        { id: 'duplicate', required: false },
      ],
    ]) {
      expect(() => createTestCaseRunContract(descriptor(assertions), [])).toThrow(
        'Invalid test case run contract'
      );
    }

    let reads = 0;
    const accessor = Object.defineProperty(descriptor(), 'assertions', {
      enumerable: true,
      get: () => {
        reads++;
        return [{ id: 'PRIVATE-ASSERTION', required: true }];
      },
    });
    expect(() => createTestCaseRunContract(accessor, [])).toThrow('Invalid test case run contract');
    expect(reads).toBe(0);

    const privateInvocation = invocation();
    privateInvocation.request.verification.input = {
      secret: 'PRIVATE-INPUT',
      oversized: 'x'.repeat(65_537),
    };
    try {
      createTestCaseRunContract(descriptor(), [privateInvocation]);
      throw new Error('expected contract rejection');
    } catch (error) {
      expect(String(error)).toContain('Invalid test case run contract');
      expect(String(error)).not.toContain('PRIVATE-INPUT');
    }
  });

  it('uses descriptor order and an exact completed-result/invocation bijection', () => {
    const definition = descriptor([
      { id: 'commit', required: true },
      { id: 'visual', required: false },
    ]);
    const both = createTestCaseRunContract(definition, [
      invocation('commit', 'assertion-op-1'),
      invocation('visual', 'assertion-op-2'),
    ]);
    const bothResults = report([
      completed('commit', 'assertion-op-1'),
      completed('visual', 'assertion-op-2'),
    ]);
    expect(both.isPassing(bothResults)).toBe(true);

    expect(() =>
      both.parse(report([completed('visual', 'assertion-op-2'), completed('commit')]))
    ).toThrow('Invalid test case run report');
    expect(() =>
      both.parse(
        report([
          completed(),
          { id: 'visual', status: 'skipped', reasonCode: 'CAPABILITY_UNAVAILABLE' },
        ])
      )
    ).toThrow('Invalid test case run report');
    expect(() =>
      createTestCaseRunContract(definition, [invocation('commit')]).parse(bothResults)
    ).toThrow('Invalid test case run report');
    expect(() =>
      createTestCaseRunContract(definition, [invocation('visual', 'assertion-op-2'), invocation()])
    ).toThrow('Invalid test case run contract');
    expect(() =>
      createTestCaseRunContract(definition, [invocation(), invocation('commit', 'another-op')])
    ).toThrow('Invalid test case run contract');
    expect(() =>
      createTestCaseRunContract(definition, [invocation(), invocation('visual', 'assertion-op-1')])
    ).toThrow('Invalid test case run contract');
  });

  it('accepts only fixed skip codes and never passes a required skip', () => {
    for (const reasonCode of ['CAPABILITY_UNAVAILABLE', 'PRECONDITION_UNAVAILABLE'] as const) {
      const contract = createTestCaseRunContract(descriptor(), []);
      const skipped = report([{ id: 'commit', status: 'skipped', reasonCode }]);
      expect(contract.parse(skipped)).toEqual(skipped);
      expect(contract.isPassing(skipped)).toBe(false);
    }

    const optional = createTestCaseRunContract(
      descriptor([
        { id: 'commit', required: true },
        { id: 'visual', required: false },
      ]),
      [invocation()]
    );
    expect(
      optional.isPassing(
        report([
          completed(),
          { id: 'visual', status: 'skipped', reasonCode: 'CAPABILITY_UNAVAILABLE' },
        ])
      )
    ).toBe(true);

    for (const reasonCode of [
      'arbitrary text',
      'CAPABILITY_UNKNOWN',
      'A'.repeat(129),
      new Error('PRIVATE'),
    ]) {
      expect(() =>
        createTestCaseRunContract(descriptor(), []).parse(
          report([{ id: 'commit', status: 'skipped', reasonCode }] as never)
        )
      ).toThrow('Invalid test case run report');
    }
  });

  it('pins case, environment, UI seam and nested verifier identity', () => {
    const contract = createTestCaseRunContract(descriptor(), [invocation()]);
    for (const input of [
      { ...report(), case: { id: 'another-case', version: '1.0.0' } },
      { ...report(), case: { id: 'counter-regression', version: '2.0.0' } },
      { ...report(), environment: { ...report().environment, cliVersion: '1.9.1' } },
      {
        ...report(),
        environment: {
          ...report().environment,
          engine: { ...report().environment.engine, version: '141.0.0' },
        },
      },
      {
        ...report(),
        environment: {
          ...report().environment,
          fixture: { ...report().environment.fixture, id: 'another-fixture' },
        },
      },
      { ...report(), assertions: [{ ...completed(), operationId: 'another-operation' }] },
      { ...report(), assertions: [] },
      {
        ...report(),
        assertions: [completed(), completed('visual', 'assertion-op-2')],
      },
      {
        ...report(),
        assertions: [
          {
            ...completed(),
            report: outcome({ testedSeam: 'application' }),
          },
        ],
      },
      {
        ...report(),
        assertions: [
          {
            ...completed(),
            report: outcome({
              verification: {
                ...outcome().outcome.verification,
                verifier: { id: 'another-verifier', version: '1.0.0' },
              },
            }),
          },
        ],
      },
      {
        ...report(),
        assertions: [
          {
            ...completed(),
            report: outcome({
              verification: {
                status: 'passed',
                verifier: { id: 'fixture-commit', version: '1.0.0' },
                requiredLayer: 'G4',
                achievedLayer: 'G4',
                evidenceRefIds: [],
              },
            }),
          },
        ],
      },
    ]) {
      expect(() => contract.parse(input)).toThrow('Invalid test case run report');
    }

    const mismatch = descriptor();
    mismatch.environment.cliVersion = '1.9.1';
    expect(() => createTestCaseRunContract(mismatch, [invocation()])).toThrow(
      'Invalid test case run contract'
    );
  });

  it('does not let another bound contract approve a valid report', () => {
    const other = descriptor();
    other.id = 'another-regression';
    other.version = '2.0.0';
    const contract = createTestCaseRunContract(other, [invocation()]);
    expect(() => contract.parse(report())).toThrow('Invalid test case run report');
  });

  it('derives aggregate truth only from setup, cleanup and required outcomes', () => {
    const contract = createTestCaseRunContract(descriptor(), [invocation()]);
    expect(contract.isPassing({ ...report(), setup: 'failed' })).toBe(false);
    expect(contract.isPassing({ ...report(), setup: 'unknown' })).toBe(false);
    expect(contract.isPassing({ ...report(), cleanup: 'failed' })).toBe(false);
    expect(contract.isPassing({ ...report(), cleanup: 'unknown' })).toBe(false);

    const unknown = outcome({
      verification: {
        status: 'unknown',
        verifier: { id: 'fixture-commit', version: '1.0.0' },
        requiredLayer: 'G4',
        evidenceRefIds: [],
      },
    });
    expect(contract.isPassing(report([{ ...completed(), report: unknown }]))).toBe(false);
  });

  it('rejects private, accessor-backed, cyclic and oversized values without reading or echoing', () => {
    const contract = createTestCaseRunContract(descriptor(), [invocation()]);
    let reads = 0;
    const accessor = Object.defineProperty(report(), 'cleanup', {
      enumerable: true,
      get: () => {
        reads++;
        return 'complete';
      },
    });
    const cyclic = report() as TestCaseRunReport & { cycle?: unknown };
    cyclic.cycle = cyclic;
    const oversized = { ...report(), privateValue: `PRIVATE-${'x'.repeat(65_537)}` };
    const exotic = Object.assign(Object.create({ privateValue: 'PRIVATE-PROTOTYPE' }), report());

    for (const input of [new Error('PRIVATE-ERROR'), accessor, cyclic, oversized, exotic]) {
      expect(() => contract.parse(input)).toThrow('Invalid test case run report');
      try {
        contract.parse(input);
      } catch (error) {
        expect(String(error)).not.toContain('PRIVATE');
      }
    }
    expect(reads).toBe(0);
  });

  it('retains bounded evidence references when case cleanup failed without passing', () => {
    const contract = createTestCaseRunContract(descriptor(), [invocation()]);
    const input = { ...report(), cleanup: 'failed' as const };
    expect(contract.parse(input).assertions[0]).toMatchObject({
      report: { outcome: { verification: { evidenceRefIds: ['fixture-event-1'] } } },
    });
    expect(contract.isPassing(input)).toBe(false);
  });
});

describe('offline test case evaluation', () => {
  it('defines strict versioned schemas and returns a caller-observed bound projection', () => {
    expect(TestCaseEvaluationInputSchema.$id).toBe(
      'urn:agentbrowser:test-case-evaluation-input:v1'
    );
    expect(TestCaseEvaluationReportSchema.$id).toBe(
      'urn:agentbrowser:test-case-evaluation-report:v1'
    );

    const input = evaluation();
    const result = evaluateTestCaseRun(input);
    expect(result).toEqual({
      schemaVersion: 1,
      provenance: 'caller_observed',
      verdict: 'passed',
      descriptor: input.descriptor,
      report: input.report,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-BUSINESS-ID');
    expect(result).not.toHaveProperty('invocations');

    input.descriptor.id = 'PRIVATE-MUTATION';
    input.report.environment.fixture.version = 'PRIVATE-MUTATION';
    expect(result.descriptor.id).toBe('counter-regression');
    expect(result.report.environment.fixture.version).toBe('1.0.0');
  });

  it('uses the existing contract as the sole truth for skips, outcomes and lifecycle', () => {
    const requiredSkip = evaluation();
    requiredSkip.invocations = [];
    requiredSkip.report.assertions = [
      { id: 'commit', status: 'skipped', reasonCode: 'PRECONDITION_UNAVAILABLE' },
    ];
    expect(evaluateTestCaseRun(requiredSkip).verdict).toBe('failed');

    const unknown = evaluation();
    unknown.report.assertions = [
      {
        ...completed(),
        report: outcome({
          verification: {
            status: 'unknown',
            verifier: { id: 'fixture-commit', version: '1.0.0' },
            requiredLayer: 'G4',
            evidenceRefIds: [],
          },
        }),
      },
    ];
    expect(evaluateTestCaseRun(unknown).verdict).toBe('failed');

    for (const lifecycle of [
      { setup: 'failed' as const },
      { setup: 'unknown' as const },
      { cleanup: 'failed' as const },
      { cleanup: 'unknown' as const },
    ]) {
      const input = evaluation();
      Object.assign(input.report, lifecycle);
      expect(evaluateTestCaseRun(input).verdict).toBe('failed');
    }

    const optional = evaluation();
    optional.descriptor.assertions.push({ id: 'visual', required: false });
    optional.report.assertions.push({
      id: 'visual',
      status: 'skipped',
      reasonCode: 'CAPABILITY_UNAVAILABLE',
    });
    expect(evaluateTestCaseRun(optional).verdict).toBe('passed');
  });

  it('rejects altered binding identities through the request-relative contract', () => {
    const altered = [
      (input: ReturnType<typeof evaluation>) => {
        input.report.case.version = '2.0.0';
      },
      (input: ReturnType<typeof evaluation>) => {
        input.report.environment.fixture.version = '2.0.0';
      },
      (input: ReturnType<typeof evaluation>) => {
        const assertion = input.report.assertions[0];
        if (assertion?.status === 'completed') assertion.operationId = 'another-operation';
      },
      (input: ReturnType<typeof evaluation>) => {
        const assertion = input.report.assertions[0];
        if (assertion?.status === 'completed') {
          assertion.report.outcome.testedSeam = 'application';
        }
      },
      (input: ReturnType<typeof evaluation>) => {
        const first = input.invocations[0];
        if (first === undefined) throw new Error('fixture invocation missing');
        first.request.verification.verifier.id = 'another-verifier';
      },
      (input: ReturnType<typeof evaluation>) => {
        const first = input.invocations[0];
        if (first === undefined) throw new Error('fixture invocation missing');
        first.request.verification.verifier.version = '2.0.0';
      },
      (input: ReturnType<typeof evaluation>) => {
        const first = input.invocations[0];
        if (first === undefined) throw new Error('fixture invocation missing');
        first.request.actions.push({ action: 'click', target: { ref: 'e1_0' } });
      },
    ];
    for (const mutate of altered) {
      const input = evaluation();
      mutate(input);
      expect(() => evaluateTestCaseRun(input)).toThrow('Invalid test case evaluation');
    }
  });

  it('rejects malformed, accessor-backed, cyclic and aggregate-oversized input privately', () => {
    let reads = 0;
    const accessor = Object.defineProperty(evaluation(), 'report', {
      enumerable: true,
      get: () => {
        reads++;
        return report();
      },
    });
    const cyclic = evaluation() as ReturnType<typeof evaluation> & { cycle?: unknown };
    cyclic.cycle = cyclic;
    const oversized = evaluation();
    const first = oversized.invocations[0];
    if (first === undefined) throw new Error('fixture invocation missing');
    first.request.verification.input = { private: 'x'.repeat(34_000) };
    const assertion = oversized.report.assertions[0];
    if (assertion?.status !== 'completed') throw new Error('fixture result missing');
    const step = assertion.report.plan.results[0];
    if (step === undefined) throw new Error('fixture plan result missing');
    step.result = { diagnostic: `PRIVATE-AGGREGATE-${'y'.repeat(34_000)}` };
    // Each component is valid in its existing owner; only the combined envelope is oversized.
    expect(
      createTestCaseRunContract(oversized.descriptor, oversized.invocations).isPassing(
        oversized.report
      )
    ).toBe(true);
    const malformed = { ...evaluation(), privateField: 'PRIVATE-UNKNOWN' };

    for (const input of [accessor, cyclic, oversized, malformed]) {
      try {
        evaluateTestCaseRun(input);
        throw new Error('expected evaluation rejection');
      } catch (error) {
        expect(String(error)).toContain('Invalid test case evaluation');
        expect(String(error)).not.toContain('PRIVATE');
      }
    }
    expect(reads).toBe(0);
  });

  it('retains failure evidence while omitting invocation inputs', () => {
    const input = evaluation();
    input.report.cleanup = 'failed';
    const result = evaluateTestCaseRun(input);
    expect(result.verdict).toBe('failed');
    expect(result.report.assertions[0]).toMatchObject({
      report: { outcome: { verification: { evidenceRefIds: ['fixture-event-1'] } } },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-BUSINESS-ID');
  });
});
