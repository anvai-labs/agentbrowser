import assert from 'node:assert/strict';
import { test } from 'node:test';

/** The layering ratchet's import detection must see deep subpaths, not just bare names. */
test('layering import regex matches bare, deep, dynamic, and require forms', async () => {
  const { WORKSPACE_IMPORT_RE } = await import('./layering-ratchet.mjs');
  const cases = [
    "import { x } from '@agentbrowser/core';",
    "import { x } from '@agentbrowser/core/private-file';",
    "const y = await import('@anvailabs/agentbrowser-mcp');",
    "const z = require('@agentbrowser/engine');",
    "export * from '@agentbrowser/core/local-artifacts';",
  ];
  for (const c of cases) {
    const re = new RegExp(WORKSPACE_IMPORT_RE.source, 'g');
    const m = re.exec(c);
    assert.ok(m, `must match: ${c}`);
    assert.match(m[1], /^@(agentbrowser|anvailabs)\/[a-z0-9-]+$/);
  }
  // The package segment (m[1]) excludes the subpath — the ratchet maps m[1] to a package.
  const re = new RegExp(WORKSPACE_IMPORT_RE.source, 'g');
  assert.equal(re.exec("from '@agentbrowser/core/private-file'")[1], '@agentbrowser/core');
  // Non-workspace specifiers must not match.
  assert.equal(new RegExp(WORKSPACE_IMPORT_RE.source, 'g').exec("from 'node:fs'"), null);
});

/** Duplication ratchet gate semantics: above fails, below fails (slack must be claimed), at passes. */
test('duplication baseline gate is a two-sided ratchet', () => {
  const BASELINE = 100;
  const gate = (actual) =>
    actual > BASELINE ? 'fail-growth' : actual < BASELINE ? 'fail-claim-slack' : 'pass';
  assert.equal(gate(101), 'fail-growth');
  assert.equal(gate(99), 'fail-claim-slack');
  assert.equal(gate(100), 'pass');
});
