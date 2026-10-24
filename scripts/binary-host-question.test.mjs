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

test('npm MCP bundle ANSWERS a host question (finding_check over stdio)', async () => {
  assert.ok(existsSync(MCP_BUNDLE), 'MCP bundle missing: run pnpm --filter @anvailabs/agentbrowser-mcp build');
  // Drive the real bundle over JSON-RPC stdio: initialize → finding_check with a
  // minimal valid ledger (one opened event + scope). The engagement check asks
  // tldts about the scope's hosts — a bundler-invisible lazy load throws here
  // even when the bundle text still contains tldts symbol names.
  const dir = mkdtempSync(join(tmpdir(), 'bundle-finding-'));
  const ledger = join(dir, 'ledger.jsonl');
  const findings = join(dir, 'findings.json');
  const opened = {
    seq: 0,
    at: '2026-10-17T00:00:00.000Z',
    type: 'engagement.opened',
    data: {
      engagementId: 'eng_bbbbbbbbbbbbbbbbbbbbbbbb',
      scope: {
        allowedHosts: ['app.test'],
        pathRules: [],
        identityBindings: [],
        expired: false,
        denials: {},
      },
    },
  };
  let prev = 'gen0000000000000000000000000000000000000000';
  const chain = [opened].map((record, seq) => {
    // FNV-1a chain (matches the engagement ledger format's hash function).
    let digest = 0x811c9dc5;
    const body = JSON.stringify({ seq, at: record.at, type: record.type, data: record.data });
    for (let i = 0; i < body.length; i++) {
      digest ^= body.charCodeAt(i);
      digest = Math.imul(digest, 0x01000193) >>> 0;
    }
    const hash = digest.toString(16).padStart(8, '0');
    const line = JSON.stringify({ seq, at: record.at, type: record.type, data: record.data, prev, hash });
    prev = hash;
    return line;
  });
  writeFileSync(ledger, chain.join('\n') + '\n');
  writeFileSync(
    findings,
    JSON.stringify([
      {
        id: 'F-1',
        title: 'Info leak',
        severity: 'medium',
        status: 'confirmed',
        url: 'https://app.test/api/x',
        description: 'x',
        ledgerRefs: [0],
        evidence: {
          method: 'independent-reproduction',
          reproducedAt: '2026-10-17T01:00:00Z',
          observation: 'x',
          cleanup: { required: false, performed: false, note: 'read-only' },
        },
      },
    ])
  );

  const { spawn } = await import('node:child_process');
  // finding tools are mode-gated (audit/appsec/bounty): start the bundle in audit mode.
  const child = spawn(process.execPath, [MCP_BUNDLE], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, AGENTBROWSER_MODE: 'audit' },
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'finding_check', arguments: { ledger, findings } },
  });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  child.kill();
  const lines = out.split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  });
  const reply = lines.find((l) => l?.id === 2);
  assert.ok(reply, `no tools/call reply; output: ${out.slice(0, 300)}`);
  const text = reply?.result?.content?.[0]?.text ?? '';
  assert.doesNotMatch(text, /is not loaded and cannot be required/, 'tldts lazy load failed in the bundle');
  // The reply text is the tool's JSON payload or a plain UsageError message; both
  // prove the host question was ANSWERED (a failed lazy load throws the
  // "cannot be required" error instead).
  assert.ok(text.length > 0, 'finding_check returned no content');
});
