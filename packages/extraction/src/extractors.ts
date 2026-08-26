/**
 * Deterministic extractors (spec section 12)
 *
 * Pure functions over engine RawPageState. No model calls, no network:
 * the same page state always yields the same bytes and the same evidence
 * hashes, so an extraction can be audited against its revision.
 */

import type { ExtractionResult } from '@agentbrowser/engine';
import type { RawPageState } from '@agentbrowser/engine';

/** FNV-1a: short, deterministic, dependency-free content hash. */
function hash(content: string): string {
  let digest = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    digest ^= content.charCodeAt(i);
    digest = Math.imul(digest, 0x01000193) >>> 0;
  }
  return digest.toString(16).padStart(8, '0');
}

/** The revision an observation was taken at, when the engine reports it. */
function revisionOf(raw: RawPageState): number {
  const revision = (raw.metadata as { revision?: unknown } | undefined)?.revision;
  return typeof revision === 'number' ? revision : 0;
}

function evidenceFor(raw: RawPageState, span?: string): NonNullable<ExtractionResult['evidence']> {
  return [
    {
      url: raw.url,
      revision: revisionOf(raw),
      ...(span !== undefined ? { text: span.slice(0, 200) } : {}),
      // Evidence attests to the source content: the same page state always
      // hashes identically, and any content change moves the hash.
      hash: hash(raw.content),
    },
  ];
}

/** Strip script/style blocks and comments, decode common entities. */
function cleanHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Collapse whitespace runs to single spaces with tidy trimming. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Inner text of a tag occurrence (first capture group helpers). */
function tagContents(html: string, tag: string): Array<{ full: string; inner: string }> {
  const results: Array<{ full: string; inner: string }> = [];
  const pattern = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  for (const match of html.matchAll(pattern)) {
    results.push({ full: match[0], inner: match[2] ?? '' });
  }
  return results;
}

/** Resolve a link URL against the page's own origin. */
function absoluteUrl(raw: RawPageState, href: string): string {
  try {
    return new URL(href, raw.url).toString();
  } catch {
    return href;
  }
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/** Visible text: everything a reader sees, whitespace collapsed. */
export function extractVisibleText(raw: RawPageState): ExtractionResult {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(cleanHtml(raw.content))?.[1] ?? raw.content;
  // Inline tags vanish without a space (so "9%</strong>." reads "9%.");
  // structural tags become word separators.
  const text = collapse(
    body
      .replace(/<\/?(a|strong|b|em|i|code|span|sup|sub|small|u)\b[^>]*>/gi, '')
      .replace(/<[^>]+>/g, ' ')
  );

  return {
    data: { text },
    evidence: evidenceFor(raw, text),
    ...(text.length === 0 ? { warnings: ['no visible text extracted'] } : {}),
  };
}

/** Article-style Markdown: headings, paragraphs, emphasis, links. */
export function extractMarkdown(raw: RawPageState): ExtractionResult {
  const cleaned = cleanHtml(raw.content);
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(cleaned)?.[1] ?? cleaned;

  let markdown = body
    // Headings.
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
      return `\n\n${'#'.repeat(Number(level))} ${collapse(stripTags(inner))}\n`;
    })
    // Links become markdown before other inline markup.
    .replace(
      /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, inner: string) => {
        const label = collapse(stripTags(inner));
        return label ? `[${label}](${absoluteUrl(raw, href)})` : '';
      }
    )
    // Emphasis.
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    // List items.
    .replace(
      /<li[^>]*>([\s\S]*?)<\/li>/gi,
      (_m, inner: string) => `\n- ${collapse(stripTags(inner))}`
    )
    // Paragraph breaks.
    .replace(/<\/(p|div|section|article|li|table)>/gi, '\n')
    // Any remaining tags.
    .replace(/<[^>]+>/g, '');

  markdown = collapse(markdown.replace(/\n\s*\n+/g, '\n\n')).replace(/\n /g, '\n');

  return {
    data: { markdown },
    evidence: evidenceFor(raw, markdown),
  };
}

/** Links with text, absolute URL and rel. */
export function extractLinks(raw: RawPageState): ExtractionResult {
  const cleaned = cleanHtml(raw.content);
  const links: Array<{ text: string; url: string; rel?: string }> = [];

  for (const match of cleaned.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1] ?? '';
    const href = /href="([^"]*)"/i.exec(attrs)?.[1];
    if (href === undefined) {
      continue;
    }
    const rel = /rel="([^"]*)"/i.exec(attrs)?.[1];
    links.push({
      text: collapse(stripTags(match[2] ?? '')),
      url: absoluteUrl(raw, href),
      ...(rel !== undefined ? { rel } : {}),
    });
  }

  return {
    data: links,
    evidence: evidenceFor(raw),
    ...(links.length === 0 ? { warnings: ['no links found'] } : {}),
  };
}

/** Tables as headers plus rows of cell text. */
export function extractTables(raw: RawPageState): ExtractionResult {
  const cleaned = cleanHtml(raw.content);
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];

  for (const table of tagContents(cleaned, 'table')) {
    const headers = [...table.inner.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) =>
      collapse(stripTags(m[1] ?? ''))
    );
    const rows = [...table.inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((row) =>
        [...(row[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) =>
          collapse(stripTags(cell[1] ?? ''))
        )
      )
      .filter((cells) => cells.length > 0);
    tables.push({ headers, rows });
  }

  return {
    data: tables,
    evidence: evidenceFor(raw),
    ...(tables.length === 0 ? { warnings: ['no tables found'] } : {}),
  };
}

/** Form controls from the observed (semantic) elements, with their refs. */
export function extractForms(raw: RawPageState): ExtractionResult {
  const controlRoles = new Set([
    'textbox',
    'searchbox',
    'textarea',
    'combobox',
    'listbox',
    'checkbox',
    'radio',
    'slider',
    'spinbutton',
    'button',
  ]);

  const controls = raw.elements
    .filter((element) => controlRoles.has(element.role) && element.ref !== undefined)
    .map((element) => ({
      ref: element.ref as string,
      role: element.role,
      ...(element.name !== undefined ? { name: element.name } : {}),
      ...(element.value !== undefined && element.value !== '' ? { value: element.value } : {}),
      ...(element.required ? { required: true } : {}),
      ...(element.enabled ? {} : { disabled: true }),
    }));

  return {
    data: controls.length > 0 ? [{ controls }] : [],
    evidence: evidenceFor(raw),
    ...(controls.length === 0 ? { warnings: ['no form controls observed'] } : {}),
  };
}

/** JSON-LD script blocks, parsed; malformed blocks warn instead of throwing. */
export function extractJsonLd(raw: RawPageState): ExtractionResult {
  const warnings: string[] = [];
  const blocks: Array<Record<string, unknown>> = [];

  let index = 0;
  for (const match of raw.content.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const parsed = JSON.parse((match[1] ?? '').trim()) as unknown;
      if (parsed !== null && typeof parsed === 'object') {
        blocks.push(parsed as Record<string, unknown>);
      }
    } catch {
      warnings.push(`malformed JSON-LD block #${index} skipped`);
    }
    index += 1;
  }

  return {
    data: blocks,
    evidence: evidenceFor(raw),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}
