import { describe, expect, it } from 'vitest';
import {
  AutofillReportSchema,
  labelPattern,
  parseAutofillReport,
  parseAutofillRequest,
} from './autofill.js';

const field = { match: { label: 'Company' }, value: 'Example' };
const navigationObservation = {
  status: 'blocked',
  reason: 'egress_policy',
  scope: 'SCOPE_HOST_DENIED',
  observedDuring: 'action',
} as const;
it('accepts bounded navigation evidence on stopped autofill receipts, never on an ok report', () => {
  const report = {
    ok: false,
    elapsedMs: 1,
    receipts: [
      {
        field: 0,
        match: field.match,
        status: 'uncertain',
        verified: false,
        actionId: 'action-1',
        navigationObservation,
      },
    ],
  };
  expect(parseAutofillReport(report)).toEqual(report);
  expect(() =>
    parseAutofillReport({
      ...report,
      ok: true,
      receipts: [{ ...report.receipts[0], status: 'unverified' }],
    })
  ).toThrow();
  expect(() =>
    parseAutofillReport({
      ...report,
      receipts: [
        {
          ...report.receipts[0],
          navigationObservation: { ...navigationObservation, url: 'https://secret.invalid/' },
        },
      ],
    })
  ).toThrow();
});
it.each([
  { fields: [] },
  { fields: Array(51).fill(field) },
  { fields: [{ ...field, option: { value: 'both' } }] },
  { fields: [field], policy: { onAmbiguous: 'first' } },
  { fields: [field], policy: { timeoutMs: -1 } },
  { fields: [{ ...field, match: { labelRegex: '(a+)+$' } }] },
  { fields: [{ ...field, option: { index: 2 } }] },
  { fields: [{ ...field, strategy: 'react-select-keyboard' }] },
])('refuses unsupported or unbounded payloads: %j', (request) => {
  expect(() => parseAutofillRequest(request)).toThrow();
});
it.each(['Chicago\nIL', 'Chicago\r', '\r\nChicago'])(
  'refuses a line break in option.value (typed text would press Enter): %j',
  (value) => {
    const request = {
      fields: [{ match: { label: 'City' }, strategy: 'react-select', option: { value } }],
    };
    expect(() => parseAutofillRequest(request)).toThrow(/line break/);
  }
);
describe('exact-set multiselect (T6 W2)', () => {
  const chips = (options: unknown, extra: Record<string, unknown> = {}) => ({
    fields: [{ match: { label: 'Codes' }, strategy: 'chip-multiselect', options, ...extra }],
  });
  it('accepts an exact set, including the empty set', () => {
    expect(
      parseAutofillRequest(chips({ values: ['Canada', 'United States'], mode: 'exact' })).fields[0]
        ?.options
    ).toEqual({ values: ['Canada', 'United States'], mode: 'exact' });
    expect(parseAutofillRequest(chips({ values: [], mode: 'exact' })).fields[0]?.options).toEqual({
      values: [],
      mode: 'exact',
    });
  });
  it.each([
    [
      'another strategy',
      {
        fields: [
          {
            match: { label: 'C' },
            strategy: 'react-select',
            options: { values: ['a'], mode: 'exact' },
          },
        ],
      },
    ],
    [
      'no strategy',
      { fields: [{ match: { label: 'C' }, options: { values: ['a'], mode: 'exact' } }] },
    ],
    ['an option as well', chips({ values: ['a'], mode: 'exact' }, { option: { value: 'a' } })],
    ['a value as well', chips({ values: ['a'], mode: 'exact' }, { value: 'a' })],
    ['a duplicate value', chips({ values: ['a', 'a'], mode: 'exact' })],
    ['a line break', chips({ values: ['a\nb'], mode: 'exact' })],
    ['an empty label', chips({ values: [''], mode: 'exact' })],
    ['a blank label', chips({ values: [' '], mode: 'exact' })],
    ['a trailing space', chips({ values: ['Canada '], mode: 'exact' })],
    ['a leading tab', chips({ values: ['\tCanada'], mode: 'exact' })],
    [
      'too many values',
      chips({ values: Array.from({ length: 33 }, (_, i) => `v${i}`), mode: 'exact' }),
    ],
    ['an over-long label', chips({ values: ['x'.repeat(513)], mode: 'exact' })],
    ['another mode', chips({ values: ['a'], mode: 'add' })],
  ])('refuses %s', (_name, request) => {
    expect(() => parseAutofillRequest(request)).toThrow();
  });
  it('reports partial effects in a receipt', () => {
    const report = parseAutofillReport(
      {
        ok: false,
        elapsedMs: 1,
        receipts: [
          {
            field: 0,
            match: { label: 'Codes' },
            status: 'uncertain',
            verified: false,
            effects: { removed: ['Canada'], added: [] },
          },
        ],
      },
      1
    );
    expect(report.receipts[0]?.effects).toEqual({ removed: ['Canada'], added: [] });
  });
});
it.each([
  ['^Company.*name$', 'Company legal name', true],
  ['^Company.*name$', 'Prior Company legal name', false],
  ['^a.*a$', 'a', false],
  ['Name$', 'Other Name', true],
  ['Company', 'Company name', true],
  ['^Name$', 'Names', false],
])('matches the bounded literal/wildcard subset %s', (pattern, label, expected) => {
  expect(labelPattern(pattern as string)(label as string)).toBe(expected);
});
it('copies a reusable mapping so callers cannot mutate pending fields', () => {
  const input = { fields: [{ ...field, match: { label: 'Company' } }] };
  const request = parseAutofillRequest(input);
  const first = input.fields[0];
  if (!first) throw new Error('Missing fixture field');
  first.match.label = 'Changed';
  expect(request.fields[0]?.match.label).toBe('Company');
});

it('validates the versioned report without changing partial or unverified outcomes', () => {
  expect(AutofillReportSchema.$id).toBe('urn:agentbrowser:autofill-report:v1');
  for (const [ok, status] of [
    [false, 'uncertain'],
    [true, 'unverified'],
  ] as const) {
    const report = {
      ok,
      receipts: [{ field: 0, match: field.match, status, verified: false }],
      elapsedMs: 1,
    };
    expect(parseAutofillReport(report)).toEqual(report);
  }
  expect(() =>
    parseAutofillReport(
      {
        ok: true,
        receipts: [{ field: 0, match: field.match, status: 'verified', verified: true }],
        elapsedMs: 1,
      },
      2
    )
  ).toThrow('may have executed');
});

it('copies repeated report references while rejecting genuine cycles', () => {
  const sharedMatch = { label: 'Company' };
  const report = {
    ok: true,
    receipts: [
      { field: 0, match: sharedMatch, status: 'verified' as const, verified: true },
      { field: 1, match: sharedMatch, status: 'verified' as const, verified: true },
    ],
    elapsedMs: 1,
  };
  expect(parseAutofillReport(report, 2)).toEqual(report);

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => parseAutofillReport({ ...report, extension: cycle }, 2)).toThrow(
    'may have executed'
  );
});

it.each([
  { ok: true, receipts: [], elapsedMs: 1 },
  {
    ok: true,
    receipts: [{ field: 1, match: field.match, status: 'verified', verified: true }],
    elapsedMs: 1,
  },
  { ok: true, receipts: [], elapsedMs: '1' },
  { ok: true, receipts: [{ field: 0, status: 'verified' }], elapsedMs: 1 },
  { ok: true, receipts: [], elapsedMs: 1, secret: 'PRIVATE-REPORT' },
])('rejects malformed reports without exposing returned values', (report) => {
  expect(() => parseAutofillReport(report)).toThrow(/^Invalid autofill report/);
  try {
    parseAutofillReport(report);
  } catch (error) {
    expect(String(error)).not.toContain('PRIVATE-REPORT');
    expect(String(error)).toContain('may have executed');
  }
});

it.each(['skipped', 'failed', 'uncertain', 'not_attempted'] as const)(
  'rejects aggregate success with a %s receipt without exposing the report',
  (status) => {
    const report = {
      ok: true,
      receipts: [
        {
          field: 0,
          match: field.match,
          status,
          verified: false,
          error: { code: 'REMOTE_FAILURE', message: 'PRIVATE-REPORT' },
        },
      ],
      elapsedMs: 1,
    };
    expect(() => parseAutofillReport(report)).toThrow(
      /^Invalid autofill report.*may have executed/
    );
    try {
      parseAutofillReport(report);
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE-REPORT');
    }
  }
);

it.each([
  { status: 'verified', verified: false },
  { status: 'unverified', verified: true },
  {
    status: 'verified',
    verified: true,
    error: { code: 'REMOTE_FAILURE', message: 'PRIVATE-REPORT' },
  },
] as const)('rejects contradictory successful receipt evidence: %j', (receipt) => {
  const report = {
    ok: true,
    receipts: [{ field: 0, match: field.match, ...receipt }],
    elapsedMs: 1,
  };
  expect(() => parseAutofillReport(report)).toThrow(/^Invalid autofill report.*may have executed/);
  try {
    parseAutofillReport(report);
  } catch (error) {
    expect(String(error)).not.toContain('PRIVATE-REPORT');
  }
});
