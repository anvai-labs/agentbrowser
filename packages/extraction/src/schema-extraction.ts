/**
 * Schema-constrained extraction (spec 12.2)
 *
 * extract.schema accepts a JSON Schema. The DEFAULT provider is fully
 * deterministic: fields are matched from the page's own text via
 * deterministic heuristics (labels, currency patterns, code patterns) -
 * no model, no invention. A pluggable model adapter can be injected for
 * harder cases; when it runs, modelUsed records it. The browser service
 * functions without an LLM: the adapter is optional, never a dependency
 * of navigation.
 */

import type { SecretManager } from '@agentbrowser/core';
import type { ExtractionResult } from '@agentbrowser/engine';
import type { RawPageState } from '@agentbrowser/engine';

/** Adapter contract for model-based extraction (spec 12.2). */
export interface ModelExtractProvider {
  /** Provider name recorded in modelUsed. */
  name: string;
  /** Extract schema-relevant fields from the gathered evidence. */
  extract(input: {
    title: string;
    text: string;
    schema: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
}

export interface SchemaExtractorOptions {
  /** Pluggable model provider; absent = deterministic matching only. */
  model?: ModelExtractProvider;
  secretManager?: SecretManager;
}

interface SchemaProperty {
  name: string;
  required: boolean;
}

/** Parse a minimal subset of JSON Schema: object with properties/required. */
function propertiesOf(schema: Record<string, unknown>): SchemaProperty[] {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  return Object.keys(properties).map((name) => ({ name, required: required.has(name) }));
}

/** FNV-1a (same as the deterministic extractors - auditable evidence). */
function hash(content: string): string {
  let digest = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    digest ^= content.charCodeAt(i);
    digest = Math.imul(digest, 0x01000193) >>> 0;
  }
  return digest.toString(16).padStart(8, '0');
}

/** Strip markup for text matching. */
function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic field matching. For each schema property, look for
 * `label value` patterns in the page text and fall back to well-known
 * page anchors (title). Never invents: unmatched fields are warnings.
 */
function matchFields(
  text: string,
  title: string,
  properties: SchemaProperty[],
  rawTitleSource: string
): { data: Record<string, string>; missing: string[] } {
  const data: Record<string, string> = {};
  const missing: string[] = [];

  for (const property of properties) {
    if (property.name === 'title') {
      // Prefer the page's main heading; fall back to the document title.
      const heading = /<h1[^>]*>([^<]{1,200})<\/h1>/i.exec(rawTitleSource)?.[1];
      const candidate = (heading ?? title).split(/\s+[|·—-]\s+/)[0]?.trim();
      if (candidate !== undefined && candidate.length > 0) {
        data.title = candidate;
        continue;
      }
    }

    // Class-scoped inner text first: <span class="price">$29.99</span>
    // is the page explicitly labeling its data.
    const classPattern = new RegExp(
      `class="[^"]*\\b${property.name}\\b[^"]*"[^>]*>([^<]{1,200})<`,
      'i'
    );
    const classMatch = classPattern.exec(rawTitleSource)?.[1]?.trim();
    if (classMatch !== undefined && classMatch.length > 0) {
      data[property.name] = classMatch;
      continue;
    }

    // `label value` adjacency in text: "price: $29.99" / "sku SKU-42".
    const pattern = new RegExp(`(?:^|\\s)${property.name}\\s*[:=]?\\s*([^\\s]{1,80})`, 'i');
    const match = pattern.exec(text);
    if (match?.[1] !== undefined) {
      data[property.name] = match[1].replace(/[,;]$/, '');
      continue;
    }

    missing.push(property.name);
  }

  return { data, missing };
}

export class SchemaExtractor {
  private readonly model: ModelExtractProvider | undefined;
  private readonly secretManager: SecretManager | undefined;

  constructor(options: SchemaExtractorOptions = {}) {
    this.model = options.model;
    this.secretManager = options.secretManager;
  }

  async extract(raw: RawPageState, schema: Record<string, unknown>): Promise<ExtractionResult> {
    const properties = propertiesOf(schema);
    const text = textOf(raw.content);
    const warnings: string[] = [];

    // Deterministic first pass - always runs, cost-free.
    const matched = matchFields(text, raw.title, properties, raw.content);
    let data: Record<string, unknown> = matched.data;

    // Model adapter for the remainder; deterministic results win.
    const remaining = properties.filter((p) => data[p.name] === undefined);
    let modelUsed: string | undefined;
    if (this.model !== undefined && remaining.length > 0) {
      const modelData = await this.model.extract({ title: raw.title, text, schema });
      modelUsed = this.model.name;
      for (const property of remaining) {
        if (modelData[property.name] !== undefined) {
          data[property.name] = modelData[property.name];
        }
      }
    }

    // Warn over the union of declared properties and required names:
    // a required field with no property declaration still deserves a
    // named warning.
    const names = new Set(properties.map((p) => p.name));
    for (const name of (schema.required as string[] | undefined) ?? []) {
      names.add(name);
    }
    for (const name of names) {
      if (data[name] === undefined) {
        const required = properties.find((p) => p.name === name)?.required ?? true;
        warnings.push(
          required
            ? `required field '${name}' not found on the page`
            : `optional field '${name}' not found on the page`
        );
      }
    }

    // Secrets never ride out in extracted values (spec 16).
    if (this.secretManager !== undefined) {
      data = this.secretManager.redact(data);
    }

    return {
      data,
      evidence: [
        {
          url: raw.url,
          revision:
            typeof (raw.metadata as { revision?: unknown } | undefined)?.revision === 'number'
              ? (raw.metadata as { revision: number }).revision
              : 0,
          hash: hash(raw.content),
        },
      ],
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(modelUsed !== undefined ? { modelUsed } : {}),
    };
  }
}
