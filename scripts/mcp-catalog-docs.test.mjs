import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCatalogDocument, renderCatalog } from './mcp-catalog-docs.mjs';
import { median, parseFootprintArgs, summarizeSamples } from './mode-footprint.mjs';

test('summarizes paired process deltas without conflating byte and memory metrics', () => {
  assert.equal(median([90, 10, 30]), 30);
  assert.equal(median([1, 2, 5, 9]), 3.5);
  assert.deepEqual(
    summarizeSamples([
      { baselineRssBytes: 0, coldRssBytes: 1000, warmRssBytes: 2000, warmHeapUsedBytes: 4 },
      { baselineRssBytes: 100, coldRssBytes: 101, warmRssBytes: 102, warmHeapUsedBytes: 6 },
      { baselineRssBytes: 200, coldRssBytes: 201, warmRssBytes: 202, warmHeapUsedBytes: 5 },
    ]),
    {
      baselineRssBytes: 100,
      coldRssBytes: 201,
      warmRssBytes: 202,
      warmHeapUsedBytes: 5,
      coldRssDeltaBytes: 1,
      warmRssDeltaBytes: 1,
    }
  );
});

test('requires bounded footprint samples and an explicit tokenizer interpreter', () => {
  assert.deepEqual(parseFootprintArgs([]), { samples: 3 });
  assert.deepEqual(parseFootprintArgs(['--samples', '5', '--tokenizer-python', '/tmp/python']), {
    samples: 5,
    tokenizerPython: '/tmp/python',
  });
  assert.throws(() => parseFootprintArgs(['--samples', '0']), /samples/);
  assert.throws(() => parseFootprintArgs(['--tokenizer-python']), /tokenizer/);
  assert.throws(() => parseFootprintArgs(['--unknown']), /usage/);
});

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
    assert.match(original, /## unbound\/qa \(15 tools; \d+ result bytes\)/);
    assert.match(original, /## delegated\/qa \(14 tools; \d+ result bytes\)/);
    assert.match(original, /## delegated\/audit \(13 tools; \d+ result bytes\)/);
    assert.match(original, /## delegated\/application \(1 tool; \d+ result bytes\)/);
    assert.match(original, /urn:agentbrowser:autofill-report:v1/);
    await writeFile(file, original.replace('browser_autofill', 'missing-tool'));
    await assert.rejects(checkCatalogDocument({ file }), /stale/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
