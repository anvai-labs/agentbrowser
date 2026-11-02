import type { SecretManager } from '@agentbrowser/core';
import { EngineError } from '@agentbrowser/engine';
import {
  PageElementSchema,
  type PageState,
  PageStateSchema,
  parseExecutionReport,
  validate,
} from '@agentbrowser/protocol';

export type OwnerRedactor = NonNullable<
  ReturnType<SecretManager['captureRegisteredScopedRedactor']>
>;
type Schema = {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  anyOf?: Schema[];
  properties?: Record<string, Schema>;
  items?: Schema;
  patternProperties?: Record<string, Schema>;
};
const STATE = PageStateSchema as unknown as Schema;
const ELEMENT = PageElementSchema as unknown as Schema;
const IDENTIFIERS = new Set(['sessionId', 'pageId', 'ref', 'focusedRef', 'scopeRef']);
const BOUNDS = { maxDepth: 32, maxNodes: 1000000, maxBytes: 64 * 1024 * 1024 };

/** Owner-private publication only; this conveys no engine read or dispatch authority. */
export function ownerPublication(capture: () => OwnerRedactor | undefined, onFailure: () => void) {
  let failed = false;
  const failure = () => {
    if (!failed) {
      failed = true;
      try {
        onFailure();
      } catch {
        // A failing recorder must not replace this fixed refusal with raw text.
      }
    }
    return new EngineError('INTERNAL', 'Credential-safe operation publication failed', false, {
      rule: 'floor.secret.redaction',
    });
  };
  let redact: OwnerRedactor;
  try {
    const captured = capture();
    if (!captured) throw failure();
    redact = captured;
  } catch {
    throw failure();
  }
  const values = <T>(input: T): T => {
    try {
      return redact(input, false) as T;
    } catch {
      throw failure();
    }
  };
  const data = <T>(input: T): T => {
    try {
      return redact(input, true) as T;
    } catch {
      throw failure();
    }
  };
  const identifier = <T extends string>(input: T): T => {
    if (values(input) !== input) throw failure();
    return input;
  };
  const suffixes = new WeakMap<object, Map<string, number>>();
  const put = (output: Record<string, unknown>, key: string, value: unknown) => {
    let safeKey = key;
    if (Object.hasOwn(output, safeKey)) {
      let next = suffixes.get(output);
      if (!next) {
        next = new Map();
        suffixes.set(output, next);
      }
      let suffix = next.get(key) ?? 1;
      do {
        safeKey = `${key}#${suffix++}`;
      } while (Object.hasOwn(output, safeKey));
      next.set(key, suffix);
    }
    Object.defineProperty(output, safeKey, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  };
  const walk = (schema: Schema | undefined, input: unknown): unknown => {
    if (!schema) return data(input);
    if (
      Object.hasOwn(schema, 'const') ||
      schema.enum ||
      schema.anyOf?.every((branch) => Object.hasOwn(branch, 'const'))
    )
      return input;
    if (schema.anyOf) {
      const branch = schema.anyOf.find((candidate) => validate(candidate, input).success);
      if (!branch) throw failure();
      return walk(branch, input);
    }
    if (typeof input === 'string') return values(input);
    if (Array.isArray(input)) return input.map((value) => walk(schema.items, value));
    if (input === null || typeof input !== 'object') return input;
    if (!schema.properties) return data(input);
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const field = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (!field) {
        put(output, values(key), data(value));
      } else if (IDENTIFIERS.has(key)) {
        put(output, key, typeof value === 'string' ? identifier(value) : value);
      } else if (key === 'properties' && schema.properties.change && schema.properties.ref) {
        // Diff property names come from PageElement, not from document keys.
        const changes: Record<string, unknown> = {};
        for (const [property, change] of Object.entries(
          value as Record<string, { old: unknown; new: unknown }>
        )) {
          const propertySchema =
            property === 'element'
              ? ELEMENT
              : ELEMENT.properties && Object.hasOwn(ELEMENT.properties, property)
                ? ELEMENT.properties[property]
                : undefined;
          const name = propertySchema ? property : values(property);
          put(changes, name, {
            old: change.old === null ? null : walk(propertySchema, change.old),
            new: change.new === null ? null : walk(propertySchema, change.new),
          });
        }
        put(output, key, changes);
      } else put(output, key, walk(field, value));
    }
    return output;
  };
  return Object.freeze({
    values,
    data,
    identifier,
    failure,
    pageState(input: PageState): PageState {
      try {
        const source = parseExecutionReport(
          PageStateSchema,
          input,
          'owner publication',
          () => true,
          BOUNDS
        );
        return parseExecutionReport(
          PageStateSchema,
          walk(STATE, source),
          'owner publication',
          () => true,
          BOUNDS
        );
      } catch {
        throw failure();
      }
    },
  });
}

export type OwnerPublication = ReturnType<typeof ownerPublication>;
