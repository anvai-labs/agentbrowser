#!/usr/bin/env node
/** Bundled-surface tldts smoke: the shipped artifacts must not only load but
 * ANSWER A HOST QUESTION. The lazy loader (packages/core/src/tldts-lazy.ts)
 * keeps tldts out of idle RSS, but a bundler-invisible load form silently
 * drops tldts from compiled binaries and the npm bundle — every artifact
 * then crashes on its first host question while initialize/--version smokes
 * stay green (PR #615 review finding). Run from the repo root after the
 * compile steps produced the artifacts:
 *
 *   node --test scripts/binary-host-question.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const CLI_BIN = `${root}packages/cli/dist-bin/agentbrowser`;
const MCP_BUNDLE = `${root}packages/mcp-server/dist/bin.js`;

test('compiled CLI answers a host question (scope import wildcard → suffix entry)', () => {
  assert.ok(existsSync(CLI_BIN), 'CLI dist-bin missing: run packages/cli/scripts/compile.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'host-question-'));
  const program = join(dir, 'program.txt');
  writeFileSync(program, '*.example.com\n', 'utf8');
  // The wildcard conversion asks tldts whether example.com is registrable —
  // the exact call shape that must not be answered by a missing module.
  const stdout = execFileSync(CLI_BIN, ['scope', 'import', program, '--from', 'text'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.match(stdout, /\.example\.com/, 'wildcard did not convert to a suffix entry');
  assert.doesNotMatch(stdout, /Cannot find module/);
});

test('npm MCP bundle embeds tldts (bundler saw the lazy import)', () => {
  assert.ok(
    existsSync(MCP_BUNDLE),
    'MCP bundle missing: run pnpm --filter @anvailabs/agentbrowser-mcp build'
  );
  const text = readFileSync(MCP_BUNDLE, 'utf8');
  // esbuild does not minify: tldts's exported names survive verbatim.
  assert.match(
    text,
    /getPublicSuffix|suffixLookup/,
    'tldts is not embedded in the npm bundle — the lazy import form became bundler-invisible'
  );
});
