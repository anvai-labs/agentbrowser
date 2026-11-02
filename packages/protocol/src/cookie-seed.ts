import { type Static, Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { UsageError } from './errors.js';
import { SCOPE_HOST_PATTERN, SessionCookieSchema } from './schemas.js';

export const CookieSeedClassSchema = Type.Union([
  Type.Literal('fingerprint-bound'),
  Type.Literal('provider-session'),
  Type.Literal('session'),
  Type.Literal('persistent'),
]);
export type CookieSeedClass = Static<typeof CookieSeedClassSchema>;
export const CookieSeedProvenanceSchema = Type.Object(
  {
    source: Type.Union([
      Type.Literal('operator-cdp'),
      Type.Literal('cookie-file'),
      Type.Literal('agentbrowser-session'),
    ]),
    sourceContext: Type.Union([
      Type.Literal('default'),
      Type.Literal('incognito'),
      Type.Literal('contained'),
      Type.Literal('unknown'),
    ]),
    sourceContextSha256: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
    extractedAt: Type.String({
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$',
    }),
    domainFilters: Type.Array(
      Type.String({ minLength: 1, maxLength: 253, pattern: SCOPE_HOST_PATTERN }),
      { maxItems: 20, uniqueItems: true }
    ),
    cookieClasses: Type.Array(CookieSeedClassSchema, { maxItems: 4, uniqueItems: true }),
  },
  { additionalProperties: false }
);
export type CookieSeedProvenance = Static<typeof CookieSeedProvenanceSchema>;
export const CookieSeedFileSchema = Type.Object(
  {
    format: Type.Literal('agentbrowser-cookie-seed/v1'),
    provenance: CookieSeedProvenanceSchema,
    cookies: Type.Array(
      Type.Object(SessionCookieSchema.properties, { additionalProperties: false }),
      { maxItems: 1000 }
    ),
  },
  { additionalProperties: false }
);
export type CookieSeedFile = Static<typeof CookieSeedFileSchema>;
const seed = TypeCompiler.Compile(CookieSeedFileSchema);

/** File metadata is advisory. No session route accepts it as credential authority. */
export function parseCookieSeedFile(value: unknown): CookieSeedFile {
  try {
    if (!seed.Check(value)) throw new Error('shape');
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error('size');
    const time = value.provenance.extractedAt;
    if (
      !Number.isFinite(Date.parse(time)) ||
      new Date(time).toISOString().replace('.000Z', 'Z') !== time.replace('.000Z', 'Z')
    )
      throw new Error('date');
    return structuredClone(value);
  } catch {
    throw new UsageError('Invalid bounded cookie seed file or provenance metadata');
  }
}
