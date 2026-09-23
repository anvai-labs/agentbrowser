import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  AutofillMatchSchema,
  type AutofillRequest,
  AutofillRequestSchema,
  AutofillScopeSchema,
  parseAutofillRequest,
} from './autofill.js';
import { snapshotJsonData } from './validators.js';

const strict = { additionalProperties: false };
const keyPattern = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';
const key = () => Type.String({ pattern: keyPattern, maxLength: 64 });
const unsafeKey = (name: string) => name === 'constructor' || name === 'prototype';

export const FormMappingSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    id: key(),
    revision: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
    }),
    scope: AutofillScopeSchema,
    fields: Type.Array(
      Type.Required(
        Type.Object(
          {
            match: AutofillMatchSchema,
            strategy: AutofillRequestSchema.properties.fields.items.properties.strategy,
            input: Type.Union([Type.Literal('value'), Type.Literal('option')]),
            valueKey: key(),
          },
          strict
        )
      ),
      { minItems: 1, maxItems: 50 }
    ),
  },
  { ...strict, $id: 'urn:agentbrowser:form-mapping:v1' }
);

export const FormValuesSchema = Type.Record(key(), Type.String({ maxLength: 8192 }), {
  ...strict,
  minProperties: 1,
  maxProperties: 50,
  $id: 'urn:agentbrowser:form-values:v1',
});
export type FormMapping = Static<typeof FormMappingSchema>;
export type FormValues = Static<typeof FormValuesSchema>;

const inputKinds: Record<
  NonNullable<AutofillRequest['fields'][number]['strategy']>,
  'value' | 'option'
> = {
  'native-input': 'value',
  'native-select': 'option',
  'react-select': 'option',
  'chip-multiselect': 'option',
};

/** Offline private join, not scope proof or authorization. Output contains private values. */
export function materializeAutofillMapping(
  mappingInput: unknown,
  valuesInput: unknown
): AutofillRequest {
  let mapping: unknown;
  let values: unknown;
  // Inspect data descriptors through the shared bounded snapshot owner, never getters.
  try {
    mapping = snapshotJsonData(mappingInput, { maxDepth: 8, maxNodes: 2000, maxBytes: 128 * 1024 });
    values = snapshotJsonData(valuesInput, { maxDepth: 2, maxNodes: 51, maxBytes: 512 * 1024 });
  } catch {
    throw new Error('Invalid form preparation input: bounded plain JSON data required');
  }
  if (!Value.Check(FormMappingSchema, mapping))
    throw new Error('Invalid form mapping: a bounded version 1 descriptor is required');
  if (
    !Value.Check(FormValuesSchema, values) ||
    (Object.getPrototypeOf(values) !== Object.prototype && Object.getPrototypeOf(values) !== null)
  )
    throw new Error('Invalid form values: a bounded own-key string record is required');
  const copy = mapping;
  const required = new Set(copy.fields.map((field) => field.valueKey));
  const keys = Object.keys(values);
  if (
    keys.length !== required.size ||
    keys.some((name) => unsafeKey(name) || !required.has(name)) ||
    [...required].some((name) => unsafeKey(name) || !Object.hasOwn(values, name))
  )
    throw new Error('Form values must exactly match the mapping keys');
  // No templates/property traversal; the only private operation is a direct own-key lookup.
  const fields = copy.fields.map(({ match, strategy, input, valueKey }) => {
    if (inputKinds[strategy] !== input)
      throw new Error('Form mapping strategy does not match its input kind');
    const value = values[valueKey] as string;
    return {
      match,
      strategy,
      verify: 'exact' as const,
      ...(input === 'value' ? { value } : { option: { value } }),
    };
  });
  const request = parseAutofillRequest({
    scope: copy.scope,
    fields,
    policy: { onAmbiguous: 'fail', onVerifyFail: 'fail' },
  });
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength + 1 > 1024 * 1024)
    throw new Error('Prepared form request exceeds the 1 MiB input bound');
  return request;
}
