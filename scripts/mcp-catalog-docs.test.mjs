import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCatalogDocument, renderCatalog } from './mcp-catalog-docs.mjs';

test('catalog digest detects nested schema drift even with unchanged tool summaries', () => {
  const catalog = [{ mode: 'fixture', tools: [{ name: 'fixture_tool', description: 'A tool. Detailed behavior.', inputSchema: { type: 'object', properties: { fields: { type: 'array', maxItems: 2 } } } }] }];
  const before = renderCatalog(catalog);
  catalog[0].tools[0].inputSchema.properties.fields.maxItems = 3;
  const after = renderCatalog(catalog);
  assert.notEqual(before, after);
  assert.equal(before.split('\n').find((line) => line.startsWith('| `fixture_tool`')), after.split('\n').find((line) => line.startsWith('| `fixture_tool`')));
});

test('generated catalog checks detect stale files across fixed profiles and bindings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-catalog-'));
  const file = join(dir, 'catalog.md');
  try {
    await checkCatalogDocument({ write: true, file });
    await checkCatalogDocument({ file });
    const original = await readFile(file, 'utf8');
    assert.match(original, /## unbound\/qa \(13 tools; \d+ result bytes\)/);
    assert.match(original, /## delegated\/qa \(12 tools; \d+ result bytes\)/);
    assert.match(original, /## delegated\/audit \(11 tools; \d+ result bytes\)/);
    assert.match(original, /## delegated\/application \(1 tool; \d+ result bytes\)/);
    assert.match(original, /urn:agentbrowser:autofill-report:v1/);
    await writeFile(file, original.replace('browser_autofill', 'missing-tool'));
    await assert.rejects(checkCatalogDocument({ file }), /stale/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
