/**
 * TDD Tests for deterministic extraction (spec section 12)
 *
 * Extractors operate on engine RawPageState - they are pure functions, not
 * LLM prompts. Every result carries evidence with content hashes so an
 * extraction can be audited against the page revision it came from.
 */

import type { RawPageState } from '@agentbrowser/engine';
import { describe, expect, it } from 'vitest';
import {
  extractForms,
  extractJsonLd,
  extractLinks,
  extractMarkdown,
  extractTables,
  extractVisibleText,
} from './extractors';

const PAGE: RawPageState = {
  url: 'https://article.example.com/post',
  title: 'Quarterly Report',
  status: 'complete',
  content: `
    <html><head>
      <title>Quarterly Report</title>
      <script type="application/ld+json">{"@type":"Article","headline":"Q3"}</script>
      <style>.x { color: red }</style>
      <script>console.log('nope')</script>
    </head><body>
      <nav><a href="/home" rel="nofollow">Home</a></nav>
      <main>
        <h1>Quarterly Report</h1>
        <p>Revenue grew <strong>12%</strong> in Q3.</p>
        <p>See the <a href="/details" rel="next">details</a>.</p>
        <table>
          <thead><tr><th>Region</th><th>Revenue</th></tr></thead>
          <tbody>
            <tr><td>EMEA</td><td>4.1M</td></tr>
            <tr><td>APAC</td><td>2.7M</td></tr>
          </tbody>
        </table>
        <form>
          <label>Email<input type="email" aria-label="Email" required /></label>
          <label>Plan<select aria-label="Plan"><option>Pro</option></select></label>
          <button type="submit">Subscribe</button>
        </form>
      </main>
    </body></html>
  `,
  elements: [
    {
      ref: 'e3_0',
      role: 'textbox',
      name: 'Email',
      value: '',
      required: true,
      visible: true,
      enabled: true,
    },
    { ref: 'e3_1', role: 'combobox', name: 'Plan', value: 'Pro', visible: true, enabled: true },
    { ref: 'e3_2', role: 'button', name: 'Subscribe', visible: true, enabled: true },
  ],
  metadata: { revision: 3 },
};

describe('extractVisibleText', () => {
  it('should return collapsed visible text without scripts and styles', () => {
    const result = extractVisibleText(PAGE);

    expect(result.data).toEqual({ text: expect.any(String) });
    const text = (result.data as { text: string }).text;
    expect(text).toContain('Quarterly Report');
    expect(text).toContain('Revenue grew 12% in Q3.');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain("console.log('nope')");
    // Whitespace collapsed.
    expect(text).not.toMatch(/\s{2,}/);
  });

  it('should carry evidence with a content hash and the source revision', () => {
    const result = extractVisibleText(PAGE);

    expect(result.evidence?.[0]).toMatchObject({
      url: PAGE.url,
      revision: 3,
    });
    expect(typeof result.evidence?.[0]?.hash).toBe('string');
  });
});

describe('extractMarkdown', () => {
  it('should render headings, paragraphs, emphasis and links as markdown', () => {
    const result = extractMarkdown(PAGE);
    const markdown = (result.data as { markdown: string }).markdown;

    expect(markdown).toContain('# Quarterly Report');
    expect(markdown).toContain('Revenue grew **12%** in Q3.');
    expect(markdown).toContain('[details](https://article.example.com/details)');
  });

  it('should resolve relative link URLs against the page', () => {
    const result = extractMarkdown(PAGE);
    expect((result.data as { markdown: string }).markdown).toContain(
      '[Home](https://article.example.com/home)'
    );
  });
});

describe('extractLinks', () => {
  it('should list text, absolute URL and rel for every link', () => {
    const result = extractLinks(PAGE);
    const links = result.data as Array<{ text: string; url: string; rel?: string }>;

    expect(links).toContainEqual({
      text: 'Home',
      url: 'https://article.example.com/home',
      rel: 'nofollow',
    });
    expect(links).toContainEqual({
      text: 'details',
      url: 'https://article.example.com/details',
      rel: 'next',
    });
  });
});

describe('extractTables', () => {
  it('should return headers and rows with a text-span evidence ref', () => {
    const result = extractTables(PAGE);
    const tables = result.data as Array<{
      headers: string[];
      rows: string[][];
    }>;

    expect(tables[0]?.headers).toEqual(['Region', 'Revenue']);
    expect(tables[0]?.rows).toEqual([
      ['EMEA', '4.1M'],
      ['APAC', '2.7M'],
    ]);
  });
});

describe('extractForms', () => {
  it('should describe controls with their observed refs', () => {
    const result = extractForms(PAGE);
    const forms = result.data as Array<{
      controls: Array<{ ref: string; role: string; name?: string; required?: boolean }>;
    }>;

    const email = forms[0]?.controls.find((c) => c.name === 'Email');
    expect(email).toMatchObject({ ref: 'e3_0', role: 'textbox', required: true });
    expect(forms[0]?.controls.some((c) => c.name === 'Subscribe')).toBe(true);
  });

  it('should warn when the page has no interactive elements', () => {
    const bare: RawPageState = { ...PAGE, elements: [] };
    const result = extractForms(bare);

    expect(result.warnings?.[0]).toContain('no form controls');
  });
});

describe('extractJsonLd', () => {
  it('should parse JSON-LD script blocks', () => {
    const result = extractJsonLd(PAGE);
    const blocks = result.data as Array<Record<string, unknown>>;

    expect(blocks[0]).toMatchObject({ '@type': 'Article', headline: 'Q3' });
  });

  it('should warn rather than throw on malformed JSON-LD', () => {
    const broken: RawPageState = {
      ...PAGE,
      content: '<script type="application/ld+json">{not json}</script>',
    };
    const result = extractJsonLd(broken);

    expect(result.data).toEqual([]);
    expect(result.warnings?.length).toBe(1);
  });
});

describe('determinism (spec: extraction is auditable)', () => {
  it('should produce identical output and hashes for identical input', () => {
    const a = extractMarkdown(PAGE);
    const b = extractMarkdown(PAGE);

    expect(a.data).toEqual(b.data);
    expect(a.evidence?.[0]?.hash).toBe(b.evidence?.[0]?.hash);
  });

  it('should change the hash when content changes', () => {
    const a = extractVisibleText(PAGE);
    const b = extractVisibleText({ ...PAGE, content: `${PAGE.content} extra` });

    expect(a.evidence?.[0]?.hash).not.toBe(b.evidence?.[0]?.hash);
  });
});
