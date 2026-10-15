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

/**
 * T6 W3a: one stage of a staged mapping. A stage is exactly the delivered single-stage shape —
 * its own exact scope URL and 1-50 fields — so per-stage readiness, pinning and refusal reuse
 * the existing scoped autofill path unchanged. Stage ORDER is the array order; which stage
 * applies to the page in front of the caller is caller-observed (the scoped preflight refuses a
 * stage whose fields are not all present), never inferred: a mapping describes pages, not
 * business state.
 */
export const FormMappingStageSchema = Type.Object(
  {
    id: key(),
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
  { ...strict, $id: 'urn:agentbrowser:form-mapping-stage:v1' }
);

export const FormMappingSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    id: key(),
    revision: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
    }),
    scope: Type.Optional(AutofillScopeSchema),
    /** Exactly one of fields (the delivered single-stage shape) or stages (T6 W3a). */
    fields: Type.Optional(FormMappingStageSchema.properties.fields),
    stages: Type.Optional(Type.Array(FormMappingStageSchema, { minItems: 1, maxItems: 12 })),
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

/**
 * T6 W3a shape validation, shared by materialization and offline listing: exactly one of
 * scope+fields (the delivered single-stage shape) or stages; unique stage ids; distinct stage
 * scope URLs. Returns whether the document is staged.
 */
function validateFormMappingShape(mapping: FormMapping): boolean {
  const staged = mapping.stages !== undefined;
  if ((mapping.fields !== undefined) === staged || (mapping.scope !== undefined) !== !staged)
    throw new Error(
      'Invalid form mapping: exactly one of scope+fields (single stage) or stages is required'
    );
  if (staged) {
    const stages = mapping.stages as NonNullable<FormMapping['stages']>;
    const ids = new Set(stages.map((stage) => stage.id));
    if (ids.size !== stages.length)
      throw new Error('Invalid form mapping: stage ids must be unique');
    const urls = new Set(stages.map((stage) => stage.scope.url));
    if (urls.size !== stages.length)
      throw new Error('Invalid form mapping: each stage needs a distinct scope URL');
  }
  return staged;
}

/**
 * T6 W3a: the stages of a mapping, in document order, for offline listing. Returns undefined for
 * a single-stage mapping. Runs the same shape validation as materialization (an invalid
 * document is refused here too, never reported as valid); reads no values.
 */
export function listFormMappingStages(
  mappingInput: unknown
): Array<{ id: string; url: string; fieldCount: number }> | undefined {
  if (!Value.Check(FormMappingSchema, mappingInput)) throw new Error('Invalid form mapping');
  const mapping = mappingInput as FormMapping;
  if (!validateFormMappingShape(mapping)) return undefined;
  return (mapping.stages as NonNullable<FormMapping['stages']>).map((stage) => ({
    id: stage.id,
    url: stage.scope.url,
    fieldCount: stage.fields.length,
  }));
}

/** Offline private join, not scope proof or authorization. Output contains private values. */
export function materializeAutofillMapping(
  mappingInput: unknown,
  valuesInput: unknown,
  stageId?: string
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
  const staged = validateFormMappingShape(mapping);
  if (staged) {
    if (stageId === undefined)
      throw new Error('Staged form mapping requires a stage id; form stages lists them');
    const stages = mapping.stages as NonNullable<FormMapping['stages']>;
    if (!stages.some((stage) => stage.id === stageId))
      throw new Error(`Unknown form mapping stage: ${stageId}`);
  } else if (stageId !== undefined) {
    throw new Error('Stage id given for a single-stage mapping');
  }
  const copy = mapping;
  const chosenFields = staged
    ? (copy.stages as NonNullable<FormMapping['stages']>).find((stage) => stage.id === stageId)
        ?.fields
    : copy.fields;
  const chosenScope = staged
    ? (copy.stages as NonNullable<FormMapping['stages']>).find((stage) => stage.id === stageId)
        ?.scope
    : copy.scope;
  const required = new Set(
    (chosenFields as NonNullable<FormMapping['fields']>).map((field) => field.valueKey)
  );
  const union = staged
    ? new Set(
        (copy.stages as NonNullable<FormMapping['stages']>).flatMap((stage) =>
          stage.fields.map((field) => field.valueKey)
        )
      )
    : required;
  if (union.size > 50)
    throw new Error(
      'Invalid form mapping: the union of stage value keys exceeds 50, which no values record can satisfy'
    );
  const keys = Object.keys(values);
  if (
    keys.length !== union.size ||
    keys.some((name) => unsafeKey(name) || !union.has(name)) ||
    [...union].some((name) => unsafeKey(name) || !Object.hasOwn(values, name))
  )
    throw new Error(
      staged
        ? 'Form values must exactly match the union of the keys of every stage'
        : 'Form values must exactly match the mapping keys'
    );
  // No templates/property traversal; the only private operation is a direct own-key lookup.
  const fields = (chosenFields as NonNullable<FormMapping['fields']>).map(
    ({ match, strategy, input, valueKey }) => {
      if (inputKinds[strategy] !== input)
        throw new Error('Form mapping strategy does not match its input kind');
      const value = values[valueKey] as string;
      return {
        match,
        strategy,
        verify: 'exact' as const,
        ...(input === 'value' ? { value } : { option: { value } }),
      };
    }
  );
  const request = parseAutofillRequest({
    scope: chosenScope,
    fields,
    policy: { onAmbiguous: 'fail', onVerifyFail: 'fail' },
  });
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength + 1 > 1024 * 1024)
    throw new Error('Prepared form request exceeds the 1 MiB input bound');
  return request;
}
