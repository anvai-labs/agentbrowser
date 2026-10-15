import { describe, expect, it } from 'vitest';
import { parseAutofillRequest } from './autofill.js';
import { materializeAutofillMapping } from './form-mapping.js';

const mapping = () => ({
  schemaVersion: 1,
  id: 'employment',
  revision: '1',
  scope: { url: 'https://example.test/apply?id=123' },
  fields: [
    {
      match: { label: 'Company', block: { id: 'past' } },
      strategy: 'native-input',
      input: 'value',
      valueKey: 'company',
    },
    {
      match: { label: 'Company', block: { id: 'current' } },
      strategy: 'native-input',
      input: 'value',
      valueKey: 'company',
    },
  ],
});
it('joins repeated private keys into the existing scoped request without retaining aliases', () => {
  const source = mapping();
  const values = { company: 'Private Co' };
  const request = materializeAutofillMapping(source, values);
  expect(request).toMatchObject({
    scope: source.scope,
    fields: [
      { match: source.fields[0]?.match, value: 'Private Co', verify: 'exact' },
      { match: source.fields[1]?.match, value: 'Private Co', verify: 'exact' },
    ],
    policy: { onAmbiguous: 'fail', onVerifyFail: 'fail' },
  });
  source.fields[0]!.match.label = 'Changed';
  values.company = 'Changed';
  expect(request.fields[0]?.match.label).toBe('Company');
  expect(request.fields[0]?.value).toBe('Private Co');
  expect(parseAutofillRequest(request)).toEqual(request);
});
it.each([
  {},
  { company: 'x', extra: 'PRIVATE-SENTINEL' },
  { company: 2 },
  { company: 'x'.repeat(8193) },
  JSON.parse('{"__proto__":"PRIVATE-SENTINEL","company":"x"}'),
  Object.create({ company: 'PRIVATE-SENTINEL' }),
])('rejects missing, extra or unsafe private values without echoing them', (values) => {
  expect(() => materializeAutofillMapping(mapping(), values)).toThrow();
  try {
    materializeAutofillMapping(mapping(), values);
  } catch (error) {
    expect(String(error)).not.toContain('PRIVATE-SENTINEL');
  }
});
it.each([
  { schemaVersion: 2 },
  { id: '' },
  { revision: '' },
  { revision: ' ' },
  { revision: 'one\ntwo' },
  { fields: [] },
  { fields: Array(51).fill(mapping().fields[0]) },
  { value: 'PRIVATE-SENTINEL' },
  { fields: [{ ...mapping().fields[0], input: 'option' }] },
  { fields: [{ ...mapping().fields[0], strategy: 'new-widget' }] },
  { fields: [{ ...mapping().fields[0], valueKey: '__proto__' }] },
  { fields: [{ ...mapping().fields[0], value: 'PRIVATE-SENTINEL' }] },
])('refuses invalid public mapping declarations %j', (delta) => {
  expect(() => materializeAutofillMapping({ ...mapping(), ...delta }, { company: 'x' })).toThrow();
});
it('supports explicit existing select strategies with option values', () => {
  const source = mapping();
  const request = materializeAutofillMapping(
    { ...source, fields: [{ ...source.fields[0], strategy: 'native-select', input: 'option' }] },
    { company: 'Example' }
  );
  expect(request.fields[0]).toMatchObject({
    option: { value: 'Example' },
    strategy: 'native-select',
  });
});
it.each([
  'https://user:secret@example.test/apply',
  'file:///tmp/form',
  'https://example.test',
  'https://EXAMPLE.test/apply',
  'https://example.test/a/../apply',
])('refuses credentials or noncanonical/non-HTTP URL %s', (url) => {
  expect(() =>
    materializeAutofillMapping({ ...mapping(), scope: { url } }, { company: 'x' })
  ).toThrow();
});
it.each([
  { fields: [{ match: { label: 'Company' }, value: 'x', verify: 'none' }] },
  { policy: { onAmbiguous: 'skip' } },
  { policy: { onVerifyFail: 'skip' } },
])('prevents scoped requests from weakening checks', (delta) => {
  const request = materializeAutofillMapping(mapping(), { company: 'x' });
  expect(() => parseAutofillRequest({ ...request, ...delta })).toThrow();
});
it('does not invoke getters and rejects symbols, cycles and exotic private containers', () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'company', {
    enumerable: true,
    get() {
      reads++;
      throw new Error('PRIVATE-SENTINEL');
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.company = cycle;
  for (const values of [
    accessor,
    cycle,
    { company: 'x', [Symbol('hidden')]: 'secret' },
    Object.assign(new Date(), { company: 'x' }),
  ]) {
    expect(() => materializeAutofillMapping(mapping(), values)).toThrow();
  }
  expect(reads).toBe(0);
  const publicAccessor = Object.defineProperty(mapping(), 'revision', {
    enumerable: true,
    get() {
      reads++;
      throw new Error('PRIVATE-SENTINEL');
    },
  });
  expect(() => materializeAutofillMapping(publicAccessor, { company: 'x' })).toThrow();
  expect(reads).toBe(0);
});
it('requires an explicit strategy on manually scoped requests', () => {
  expect(() =>
    parseAutofillRequest({
      scope: mapping().scope,
      fields: [{ match: { label: 'Company' }, value: 'x' }],
    })
  ).toThrow();
});
it('enforces a total private-data bound as well as per-value limits', () => {
  const fields = Array.from({ length: 50 }, (_, i) => ({
    ...mapping().fields[0],
    valueKey: `k${i}`,
  }));
  const values = Object.fromEntries(fields.map((f) => [f.valueKey, '😀'.repeat(4096)]));
  // At most 8192 UTF-16 units each, but >512 KiB in UTF-8 overall.
  expect(() => materializeAutofillMapping({ ...mapping(), fields }, values)).toThrow();
});
it('rejects a repeated private value whose materialized wire request exceeds the CLI input bound', () => {
  const source = mapping();
  expect(() =>
    materializeAutofillMapping(
      {
        ...source,
        fields: Array.from({ length: 50 }, (_, i) => ({
          ...source.fields[0],
          match: { label: `field${i}` },
        })),
      },
      { company: '界'.repeat(8192) }
    )
  ).toThrow();
});
it('sanitizes exceptions from reflective proxies at the local preparation boundary', () => {
  const value = new Proxy(
    { company: 'x' },
    {
      ownKeys() {
        throw new Error('PRIVATE-SENTINEL');
      },
    }
  );
  expect(() => materializeAutofillMapping(mapping(), value)).toThrow(
    'Invalid form preparation input'
  );
});

describe('staged mappings (T6 W3a)', () => {
  const stageField = (label: string, valueKey: string) => ({
    match: { label },
    strategy: 'native-input',
    input: 'value',
    valueKey,
  });
  const staged = () => ({
    schemaVersion: 1,
    id: 'onboarding',
    revision: 'r1',
    stages: [
      {
        id: 'account',
        scope: { url: 'https://example.test/signup/1' },
        fields: [stageField('Full name', 'name'), stageField('Email', 'email')],
      },
      {
        id: 'profile',
        scope: { url: 'https://example.test/signup/2' },
        fields: [stageField('Full name', 'name'), stageField('Bio', 'bio')],
      },
    ],
  });
  const values = { name: 'Ada', email: 'ada@example.test', bio: 'Engineer' };

  it('materializes one chosen stage; values match the union across stages', () => {
    const second = materializeAutofillMapping(staged(), values, 'profile');
    expect(second.scope).toEqual({ url: 'https://example.test/signup/2' });
    expect(
      second.fields.map(
        (field: { value?: string; option?: { value: string } }) =>
          field.value ?? field.option?.value
      )
    ).toEqual(['Ada', 'Engineer']);
    const first = materializeAutofillMapping(staged(), values, 'account');
    expect(first.scope).toEqual({ url: 'https://example.test/signup/1' });
  });

  it('a single-stage mapping is unchanged and needs no stage argument', () => {
    const single = {
      schemaVersion: 1,
      id: 'plain',
      revision: 'r1',
      scope: { url: 'https://example.test/form' },
      fields: [stageField('Full name', 'name')],
    };
    expect(materializeAutofillMapping(single, { name: 'Ada' })).toMatchObject({
      scope: { url: 'https://example.test/form' },
    });
  });

  it.each([
    ['a staged mapping without a stage argument', staged(), values, undefined],
    ['an unknown stage', staged(), values, 'missing'],
    ['values missing a union key', staged(), { name: 'Ada' }, 'account'],
    ['values with an extra key', staged(), { ...values, extra: 'x' }, 'account'],
  ])('refuses %s', (_name, mapping, valuesInput, stage) => {
    expect(() =>
      materializeAutofillMapping(mapping as never, valuesInput as never, stage)
    ).toThrow();
  });

  it.each([
    ['both fields and stages', () => ({ ...staged(), fields: [stageField('Full name', 'name')] })],
    ['an empty stages array', () => ({ ...staged(), stages: [] })],
    [
      'duplicate stage ids',
      () => ({ ...staged(), stages: [...staged().stages, ...staged().stages] }),
    ],
    [
      'a bad stage id',
      () => {
        const m = staged();
        m.stages[1].id = 'bad id';
        return m;
      },
    ],
    [
      'two stages with the same scope URL',
      () => {
        const m = staged();
        m.stages[1].scope = { ...m.stages[0].scope };
        return m;
      },
    ],
    [
      'a stage field without a strategy',
      () => {
        const m = staged();
        (m.stages[0].fields[0] as { strategy?: string }).strategy = undefined as never;
        return m;
      },
    ],
  ])('refuses a staged mapping with %s', (_name, build) => {
    expect(() => materializeAutofillMapping(build() as never, values, 'account')).toThrow();
  });
});
